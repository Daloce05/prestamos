// Dependencias del servidor.
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

// Carga variables de entorno desde .env cuando existe.
require("dotenv").config();

// Configuracion de la app Express.
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// Pool de conexion Postgres (soporta DATABASE_URL o variables individuales).
const pool = process.env.DATABASE_URL
	? new Pool({ connectionString: process.env.DATABASE_URL })
	: new Pool({
			host: process.env.DB_HOST || "localhost",
			port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
			user: process.env.DB_USER || "postgres",
			password: process.env.DB_PASSWORD || "postgres",
			database: process.env.DB_NAME || "prestamos",
		});

/**
 * Redondea a 2 decimales para consistencia en calculos y almacenamiento.
 */
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/**
 * Obtiene timestamp actual en formato ISO para escrituras en BD.
 */
const nowIso = () => new Date().toISOString();

/**
 * Normaliza un valor a YYYY-MM-DD (seguro para columnas DATE).
 */
const toDateOnly = (dateValue) => {
  if (!dateValue) return new Date().toISOString().slice(0, 10);

  // Si ya viene como string YYYY-MM-DD (Postgres DATE suele venir así)
  if (typeof dateValue === "string") {
    return dateValue.slice(0, 10);
  }

  // Si viene como Date object
  return dateValue.toISOString().slice(0, 10);
};


/**
 * Suma meses a una fecha YYYY-MM-DD, preservando el dia cuando sea posible.
 */
const addMonths = (dateString, months) => {
	const date = new Date(dateString);
	const targetMonth = date.getMonth() + months;
	const targetDate = new Date(date.getFullYear(), targetMonth, date.getDate());
	return toDateOnly(targetDate);
};

/**
 * Obtiene la siguiente fecha quincenal en o despues de la dada.
 */
const nextQuincenalFrom = (dateString) => {
  const date = new Date(dateString + "T00:00:00");
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();

  if (day <= 1) return toDateOnly(new Date(year, month, 1));
  if (day <= 15) return toDateOnly(new Date(year, month, 15));
  return toDateOnly(new Date(year, month + 1, 1));
};


/**
 * Obtiene la siguiente fecha quincenal estrictamente despues de la dada.
 */
const nextQuincenalAfter = (dateString) => {
  const date = new Date(dateString + "T00:00:00");
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();

  if (day <= 1) {
    return toDateOnly(new Date(year, month, 15));
  }

  if (day <= 15) {
    return toDateOnly(new Date(year, month + 1, 1));
  }

  return toDateOnly(new Date(year, month + 1, 15));
};


/**
 * Construye un calendario quincenal desde la fecha del prestamo.
 */
const buildQuincenalSchedule = (loanDateValue, installmentsCount) => {
	const dates = [];
	let current = nextQuincenalFrom(loanDateValue);
	for (let i = 1; i <= installmentsCount; i += 1) {
		const dueDate = i === 1 ? current : nextQuincenalAfter(current);
		dates.push(dueDate);
		current = dueDate;
	}
	return dates;
};

/**
 * Asegura fechas quincenales si las cuotas quedaron con la misma fecha.
 */
const ensureQuincenalInstallments = async (loan) => {
	const installments = await query(
		"SELECT id, number, due_date FROM installments WHERE loan_id = $1 ORDER BY number ASC",
		[loan.id]
	);
	if (installments.rowCount <= 1) return;
	const uniqueDates = new Set(installments.rows.map((row) => toDateOnly(row.due_date)));
	if (uniqueDates.size > 1) return;
	const schedule = buildQuincenalSchedule(loan.loan_date, loan.installments_count);
	const clientConnection = await pool.connect();
	try {
		await clientConnection.query("BEGIN");
		for (let i = 0; i < installments.rows.length; i += 1) {
			await clientConnection.query("UPDATE installments SET due_date = $1 WHERE id = $2", [
				schedule[i],
				installments.rows[i].id,
			]);
		}
		await clientConnection.query("COMMIT");
	} catch (error) {
		await clientConnection.query("ROLLBACK");
		throw error;
	} finally {
		clientConnection.release();
	}
};

/**
 * Envuelve pool.query para consistencia.
 */
const query = (text, params) => pool.query(text, params);

/**
 * Inicializa el esquema de BD y siembra filas requeridas.
 */
const initDb = async () => {
	await query(`
		CREATE TABLE IF NOT EXISTS capital (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			amount NUMERIC(14,2) NOT NULL,
			updated_at TIMESTAMP NOT NULL
		);

		CREATE TABLE IF NOT EXISTS capital_movements (
			id SERIAL PRIMARY KEY,
			type TEXT NOT NULL,
			amount NUMERIC(14,2) NOT NULL,
			loan_id INTEGER,
			payment_id INTEGER,
			note TEXT,
			created_at TIMESTAMP NOT NULL
		);

		CREATE TABLE IF NOT EXISTS clients (
			id SERIAL PRIMARY KEY,
			full_name TEXT NOT NULL,
			document TEXT NOT NULL,
			phone TEXT NOT NULL,
			address TEXT,
			created_at TIMESTAMP NOT NULL
		);

		CREATE TABLE IF NOT EXISTS loans (
			id SERIAL PRIMARY KEY,
			client_id INTEGER NOT NULL REFERENCES clients(id),
			amount NUMERIC(14,2) NOT NULL,
			loan_date DATE NOT NULL,
			installments_count INTEGER NOT NULL,
			status TEXT NOT NULL,
			notes TEXT,
			base_installment NUMERIC(14,2) NOT NULL,
			interest_per_installment NUMERIC(14,2) NOT NULL,
			installment_total NUMERIC(14,2) NOT NULL,
			total_payable NUMERIC(14,2) NOT NULL,
			paid_total NUMERIC(14,2) NOT NULL DEFAULT 0,
			pending_total NUMERIC(14,2) NOT NULL,
			created_at TIMESTAMP NOT NULL
		);

		CREATE TABLE IF NOT EXISTS installments (
			id SERIAL PRIMARY KEY,
			loan_id INTEGER NOT NULL REFERENCES loans(id),
			number INTEGER NOT NULL,
			due_date DATE NOT NULL,
			amount NUMERIC(14,2) NOT NULL,
			status TEXT NOT NULL,
			paid_date DATE,
			paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0
		);

		CREATE TABLE IF NOT EXISTS payments (
			id SERIAL PRIMARY KEY,
			client_id INTEGER NOT NULL REFERENCES clients(id),
			loan_id INTEGER NOT NULL REFERENCES loans(id),
			installment_id INTEGER REFERENCES installments(id),
			payment_date DATE NOT NULL,
			amount NUMERIC(14,2) NOT NULL,
			type TEXT NOT NULL DEFAULT 'payment',
			notes TEXT,
			created_at TIMESTAMP NOT NULL
		);
	`);

	await query("ALTER TABLE payments ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'payment'");

	const existing = await query("SELECT amount FROM capital WHERE id = 1");
	if (existing.rowCount === 0) {
		await query("INSERT INTO capital (id, amount, updated_at) VALUES (1, 0, $1)", [nowIso()]);
	}
};

/**
 * Obtiene el capital actual y su ultima actualizacion.
 */
const getCapital = async () => {
	const result = await query("SELECT amount, updated_at FROM capital WHERE id = 1");
	return result.rows[0];
};

/**
 * Actualiza el capital y su timestamp.
 */
const setCapital = async (amount) => {
	await query("UPDATE capital SET amount = $1, updated_at = $2 WHERE id = 1", [amount, nowIso()]);
};

/**
 * Inserta un movimiento de capital para auditoria.
 */
const insertCapitalMovement = async ({ type, amount, loanId, paymentId, note }) => {
	await query(
		"INSERT INTO capital_movements (type, amount, loan_id, payment_id, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
		[type, amount, loanId ?? null, paymentId ?? null, note ?? null, nowIso()]
	);
};

/**
 * Calcula cuotas y total con interes fijo por cuota.
 */
const computeLoanFields = (amount, installmentsCount) => {
	const baseInstallment = round2(amount / installmentsCount);
	const interestPerInstallment = round2(amount * 0.05);
	const installmentTotal = round2(baseInstallment + interestPerInstallment);
	const totalPayable = round2(installmentTotal * installmentsCount);
	return {
		baseInstallment,
		interestPerInstallment,
		installmentTotal,
		totalPayable,
	};
};

/**
 * Actualiza estados de cuotas segun fecha y monto pagado.
 */
const refreshInstallmentStatuses = async (loanId) => {
	const today = toDateOnly(new Date());
	const pending = await query(
		"SELECT id, due_date, status, amount, paid_amount FROM installments WHERE loan_id = $1",
		[loanId]
	);

	for (const installment of pending.rows) {
		if (Number(installment.paid_amount) >= Number(installment.amount) && installment.status !== "Pagada") {
			await query("UPDATE installments SET status = $1 WHERE id = $2", ["Pagada", installment.id]);
		} else if (installment.due_date < today && Number(installment.paid_amount) < Number(installment.amount)) {
			if (installment.status !== "Atrasada") {
				await query("UPDATE installments SET status = $1 WHERE id = $2", ["Atrasada", installment.id]);
			}
		} else if (Number(installment.paid_amount) < Number(installment.amount) && installment.status !== "Pendiente") {
			await query("UPDATE installments SET status = $1 WHERE id = $2", ["Pendiente", installment.id]);
		}
	}
};

/**
 * Recalcula totales y estado del prestamo desde sus cuotas.
 */
const updateLoanTotalsAndStatus = async (loanId) => {
	await refreshInstallmentStatuses(loanId);
	const totals = await query(
		"SELECT SUM(paid_amount) as paid_total, SUM(amount) as amount_total FROM installments WHERE loan_id = $1",
		[loanId]
	);
	const paidTotal = round2(totals.rows[0]?.paid_total ?? 0);
	const amountTotal = round2(totals.rows[0]?.amount_total ?? 0);
	const pendingTotal = round2(amountTotal - paidTotal);

	const statusCounts = await query(
		"SELECT SUM(CASE WHEN status = 'Atrasada' THEN 1 ELSE 0 END) AS late, SUM(CASE WHEN status = 'Pendiente' THEN 1 ELSE 0 END) AS pending FROM installments WHERE loan_id = $1",
		[loanId]
	);

	let status = "Activo";
	if (pendingTotal <= 0) {
		status = "Finalizado";
	} else if (Number(statusCounts.rows[0]?.late ?? 0) > 0) {
		status = "En mora";
	}

	await query("UPDATE loans SET paid_total = $1, pending_total = $2, status = $3 WHERE id = $4", [
		paidTotal,
		pendingTotal,
		status,
		loanId,
	]);
};

/**
 * Elimina un prestamo y sus dependencias en transaccion.
 */
const deleteLoanCascade = async (clientConnection, loanId) => {
	const paymentIdsResult = await clientConnection.query("SELECT id FROM payments WHERE loan_id = $1", [loanId]);
	const paymentIds = paymentIdsResult.rows.map((row) => row.id);
	await clientConnection.query("DELETE FROM capital_movements WHERE loan_id = $1", [loanId]);
	if (paymentIds.length > 0) {
		await clientConnection.query("DELETE FROM capital_movements WHERE payment_id = ANY($1::int[])", [paymentIds]);
	}
	await clientConnection.query("DELETE FROM payments WHERE loan_id = $1", [loanId]);
	await clientConnection.query("DELETE FROM installments WHERE loan_id = $1", [loanId]);
	await clientConnection.query("DELETE FROM loans WHERE id = $1", [loanId]);
};

/**
 * Inicia el servidor API y registra rutas.
 */
const start = async () => {
	await initDb();

	// Health check para monitoreo de disponibilidad.
	app.get("/health", (req, res) => {
		res.json({ status: "ok" });
	});

	// Resumen de capital para el dashboard.
	app.get("/capital", async (req, res) => {
		res.json(await getCapital());
	});

	// Establece el capital a un valor absoluto.
	app.put("/capital", async (req, res) => {
	const amount = Number(req.body?.amount);
	if (!Number.isFinite(amount) || amount < 0) {
		return res.status(400).json({ error: "amount must be a non-negative number" });
	}
	const current = await getCapital();
	const delta = round2(amount - Number(current.amount));
	await setCapital(round2(amount));
	if (delta !== 0) {
		await insertCapitalMovement({ type: "manual_set", amount: delta, note: "Capital actualizado manualmente" });
	}
	res.json(await getCapital());
	});

	// Ajusta el capital por un delta.
	app.post("/capital/adjust", async (req, res) => {
	const delta = Number(req.body?.delta);
	if (!Number.isFinite(delta)) {
		return res.status(400).json({ error: "delta must be a number" });
	}
	const current = await getCapital();
	const next = round2(Number(current.amount) + delta);
	if (next < 0) {
		return res.status(400).json({ error: "capital cannot be negative" });
	}
	await setCapital(next);
	await insertCapitalMovement({ type: "manual_adjust", amount: delta, note: req.body?.note });
	res.json(await getCapital());
	});

	// Crea un nuevo cliente.
	app.post("/clients", async (req, res) => {
	const { fullName, document, phone, address } = req.body || {};
	if (!fullName || !document || !phone) {
		return res.status(400).json({ error: "fullName, document and phone are required" });
	}
	const result = await query(
		"INSERT INTO clients (full_name, document, phone, address, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id",
		[fullName, document, phone, address ?? null, nowIso()]
	);
	res.status(201).json({ id: result.rows[0].id });
	});

	// Lista todos los clientes.
	app.get("/clients", async (req, res) => {
		const clients = await query("SELECT * FROM clients ORDER BY created_at DESC");
		res.json(clients.rows);
	});

	// Obtiene un cliente y sus prestamos.
	app.get("/clients/:id", async (req, res) => {
		const client = await query("SELECT * FROM clients WHERE id = $1", [req.params.id]);
		if (client.rowCount === 0) {
			return res.status(404).json({ error: "client not found" });
		}
		const loans = await query("SELECT * FROM loans WHERE client_id = $1 ORDER BY created_at DESC", [
			client.rows[0].id,
		]);
		res.json({ ...client.rows[0], loans: loans.rows });
	});

	// Elimina un cliente y sus prestamos asociados.
	app.delete("/clients/:id", async (req, res) => {
		const clientId = Number(req.params.id);
		if (!Number.isFinite(clientId)) {
			return res.status(400).json({ error: "client id must be a number" });
		}
		const clientConnection = await pool.connect();
		try {
			await clientConnection.query("BEGIN");
			const client = await clientConnection.query("SELECT id FROM clients WHERE id = $1", [clientId]);
			if (client.rowCount === 0) {
				await clientConnection.query("ROLLBACK");
				return res.status(404).json({ error: "client not found" });
			}
			const loans = await clientConnection.query("SELECT id FROM loans WHERE client_id = $1", [clientId]);
			for (const loan of loans.rows) {
				await deleteLoanCascade(clientConnection, loan.id);
			}
			await clientConnection.query("DELETE FROM clients WHERE id = $1", [clientId]);
			await clientConnection.query("COMMIT");
			res.json({ ok: true, deleted_loans: loans.rowCount });
		} catch (error) {
			await clientConnection.query("ROLLBACK");
			throw error;
		} finally {
			clientConnection.release();
		}
	});

	// Crea un prestamo con cuotas y movimiento de capital.
	app.post("/loans", async (req, res) => {
	const { clientId, amount, loanDate, installmentsCount, notes } = req.body || {};
	const parsedAmount = Number(amount);
	const parsedInstallments = Number(installmentsCount);
	if (!clientId || !Number.isFinite(parsedAmount) || parsedAmount <= 0 || !Number.isFinite(parsedInstallments)) {
		return res.status(400).json({ error: "clientId, amount and installmentsCount are required" });
	}
	if (parsedInstallments <= 0) {
		return res.status(400).json({ error: "installmentsCount must be greater than 0" });
	}

	const client = await query("SELECT id FROM clients WHERE id = $1", [clientId]);
	if (client.rowCount === 0) {
		return res.status(404).json({ error: "client not found" });
	}

	const capital = await getCapital();
	if (Number(capital.amount) < parsedAmount) {
		return res.status(400).json({ error: "capital insuficiente" });
	}

	const { baseInstallment, interestPerInstallment, installmentTotal, totalPayable } = computeLoanFields(
		parsedAmount,
		parsedInstallments
	);

	const loanDateValue = toDateOnly(loanDate);

	const clientConnection = await pool.connect();
	try {
		await clientConnection.query("BEGIN");
		const loanResult = await clientConnection.query(
			`INSERT INTO loans
			 (client_id, amount, loan_date, installments_count, status, notes, base_installment, interest_per_installment, installment_total, total_payable, paid_total, pending_total, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
			 RETURNING id`,
			[
				clientId,
				round2(parsedAmount),
				loanDateValue,
				parsedInstallments,
				"Activo",
				notes ?? null,
				baseInstallment,
				interestPerInstallment,
				installmentTotal,
				totalPayable,
				0,
				totalPayable,
				nowIso(),
			]
		);

		const loanId = loanResult.rows[0].id;
		let currentDate = nextQuincenalFrom(loanDateValue);
		for (let i = 1; i <= parsedInstallments; i += 1) {
			const dueDate = i === 1 ? currentDate : nextQuincenalAfter(currentDate);
			await clientConnection.query(
				"INSERT INTO installments (loan_id, number, due_date, amount, status, paid_amount) VALUES ($1, $2, $3, $4, $5, $6)",
				[loanId, i, dueDate, installmentTotal, "Pendiente", 0]
			);
			currentDate = dueDate;
		}

		const newCapital = round2(Number(capital.amount) - parsedAmount);
		await clientConnection.query("UPDATE capital SET amount = $1, updated_at = $2 WHERE id = 1", [
			newCapital,
			nowIso(),
		]);
		await clientConnection.query(
			"INSERT INTO capital_movements (type, amount, loan_id, payment_id, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
			["loan", -parsedAmount, loanId, null, "Préstamo creado", nowIso()]
		);

		await clientConnection.query("COMMIT");
		res.status(201).json({ id: loanId });
	} catch (error) {
		await clientConnection.query("ROLLBACK");
		throw error;
	} finally {
		clientConnection.release();
	}
	});

	// Lista prestamos con filtros opcionales.
	app.get("/loans", async (req, res) => {
	const { status, clientId } = req.query || {};
	const clauses = [];
	const params = [];
	if (status) {
		clauses.push("status = $" + (params.length + 1));
		params.push(status);
	}
	if (clientId) {
		clauses.push("client_id = $" + (params.length + 1));
		params.push(clientId);
	}
	const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
	const loans = await query(
		`SELECT loans.*, clients.full_name AS client_name
		 FROM loans
		 JOIN clients ON loans.client_id = clients.id
		 ${where}
		 ORDER BY loans.created_at DESC`,
		params
	);
	res.json(loans.rows);
	});

	// Obtiene un prestamo con cuotas y pagos.
	app.get("/loans/:id", async (req, res) => {
		const loan = await query("SELECT * FROM loans WHERE id = $1", [req.params.id]);
		if (loan.rowCount === 0) {
			return res.status(404).json({ error: "loan not found" });
		}
		await ensureQuincenalInstallments(loan.rows[0]);
		await refreshInstallmentStatuses(loan.rows[0].id);
		const installments = await query("SELECT * FROM installments WHERE loan_id = $1 ORDER BY number ASC", [
			loan.rows[0].id,
		]);
		const payments = await query("SELECT * FROM payments WHERE loan_id = $1 ORDER BY payment_date DESC", [
			loan.rows[0].id,
		]);
		res.json({ ...loan.rows[0], installments: installments.rows, payments: payments.rows });
	});

	// Lista pagos recientes para el historial.
	app.get("/payments", async (req, res) => {
		const payments = await query(
			`SELECT
				payments.*,
				clients.full_name AS client_name,
				loans.amount AS loan_amount
			FROM payments
			JOIN clients ON payments.client_id = clients.id
			JOIN loans ON payments.loan_id = loans.id
			ORDER BY payments.created_at DESC
			LIMIT 20`
		);
		res.json(payments.rows);
	});

	// Actualiza manualmente el estado de un prestamo.
	app.put("/loans/:id/status", async (req, res) => {
		const loanId = Number(req.params.id);
		const status = req.body?.status;
		const allowed = ["Activo", "Finalizado", "En mora"];
		if (!Number.isFinite(loanId)) {
			return res.status(400).json({ error: "loan id must be a number" });
		}
		if (!allowed.includes(status)) {
			return res.status(400).json({ error: "status must be Activo, Finalizado or En mora" });
		}
		const result = await query("UPDATE loans SET status = $1 WHERE id = $2", [status, loanId]);
		if (result.rowCount === 0) {
			return res.status(404).json({ error: "loan not found" });
		}
		res.json({ status });
	});

	// Elimina un prestamo y datos relacionados.
	app.delete("/loans/:id", async (req, res) => {
		const loanId = Number(req.params.id);
		if (!Number.isFinite(loanId)) {
			return res.status(400).json({ error: "loan id must be a number" });
		}
		const clientConnection = await pool.connect();
		try {
			await clientConnection.query("BEGIN");
			const loan = await clientConnection.query("SELECT id FROM loans WHERE id = $1", [loanId]);
			if (loan.rowCount === 0) {
				await clientConnection.query("ROLLBACK");
				return res.status(404).json({ error: "loan not found" });
			}
			await deleteLoanCascade(clientConnection, loanId);
			await clientConnection.query("COMMIT");
			res.json({ ok: true });
		} catch (error) {
			await clientConnection.query("ROLLBACK");
			throw error;
		} finally {
			clientConnection.release();
		}
	});

	// Registra un pago (normal o pago total).
	app.post("/payments", async (req, res) => {
	const { clientId, loanId, installmentId, amount, paymentDate, notes, payoff } = req.body || {};
	const payoffRequested = Boolean(payoff);
	const parsedAmount = Number(amount);
	if (!payoffRequested && (!Number.isFinite(parsedAmount) || parsedAmount <= 0)) {
		return res.status(400).json({ error: "amount must be greater than 0" });
	}
	const roundedAmount = Number.isFinite(parsedAmount) ? round2(parsedAmount) : 0;

	let resolvedLoanId = loanId;
	let resolvedClientId = clientId;
	const clientConnection = await pool.connect();
	try {
		await clientConnection.query("BEGIN");

		let installmentRow = null;
		if (!payoffRequested && installmentId) {
			const installment = await clientConnection.query(
				"SELECT installments.*, loans.client_id as client_id FROM installments JOIN loans ON installments.loan_id = loans.id WHERE installments.id = $1 FOR UPDATE",
				[installmentId]
			);
			if (installment.rowCount === 0) {
				await clientConnection.query("ROLLBACK");
				return res.status(404).json({ error: "installment not found" });
			}
			installmentRow = installment.rows[0];
			resolvedLoanId = installmentRow.loan_id;
			resolvedClientId = installmentRow.client_id;
		}

		if (!resolvedLoanId) {
			await clientConnection.query("ROLLBACK");
			return res.status(400).json({ error: "loanId is required" });
		}

		const loan = await clientConnection.query("SELECT * FROM loans WHERE id = $1 FOR UPDATE", [resolvedLoanId]);
		if (loan.rowCount === 0) {
			await clientConnection.query("ROLLBACK");
			return res.status(404).json({ error: "loan not found" });
		}
		if (!resolvedClientId) {
			resolvedClientId = loan.rows[0].client_id;
		}

		const installments = await clientConnection.query(
			"SELECT * FROM installments WHERE loan_id = $1 ORDER BY number ASC FOR UPDATE",
			[resolvedLoanId]
		);

		const totals = await clientConnection.query(
			"SELECT SUM(paid_amount) as paid_total, SUM(amount) as amount_total FROM installments WHERE loan_id = $1",
			[resolvedLoanId]
		);
		const paidTotal = round2(totals.rows[0]?.paid_total ?? 0);
		const amountTotal = round2(totals.rows[0]?.amount_total ?? 0);
		const pendingTotal = round2(amountTotal - paidTotal);
		if (pendingTotal <= 0) {
			await clientConnection.query("ROLLBACK");
			return res.status(400).json({ error: "loan already paid" });
		}

		const paymentDateValue = toDateOnly(paymentDate);
		let paymentAmount = roundedAmount;

		if (payoffRequested) {
			const baseInstallment = Number(loan.rows[0].base_installment);
			const interestPerInstallment = Number(loan.rows[0].interest_per_installment);
			let payoffTotal = 0;
			for (const inst of installments.rows) {
				const paidAmount = Number(inst.paid_amount);
				const principalPaid = Math.min(
					baseInstallment,
					Math.max(0, paidAmount - interestPerInstallment)
				);
				const principalPending = round2(baseInstallment - principalPaid);
				if (principalPending <= 0) continue;
				payoffTotal = round2(payoffTotal + principalPending);
			}
			if (payoffTotal <= 0) {
				await clientConnection.query("ROLLBACK");
				return res.status(400).json({ error: "loan already paid" });
			}
			paymentAmount = payoffTotal;
		} else if (paymentAmount > pendingTotal) {
			await clientConnection.query("ROLLBACK");
			return res.status(400).json({ error: "amount exceeds loan pending total" });
		}

		const paymentResult = await clientConnection.query(
			"INSERT INTO payments (client_id, loan_id, installment_id, payment_date, amount, type, notes, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
			[
				resolvedClientId,
				resolvedLoanId,
				payoffRequested ? null : installmentId ?? null,
				paymentDateValue,
				paymentAmount,
				payoffRequested ? "payoff" : "payment",
				notes ?? null,
				nowIso(),
			]
		);

		if (payoffRequested) {
			const baseInstallment = Number(loan.rows[0].base_installment);
			const interestPerInstallment = Number(loan.rows[0].interest_per_installment);
			for (const inst of installments.rows) {
				const paidAmount = Number(inst.paid_amount);
				const principalPaid = Math.min(
					baseInstallment,
					Math.max(0, paidAmount - interestPerInstallment)
				);
				const principalPending = round2(baseInstallment - principalPaid);
				if (principalPending <= 0) continue;
				const newPaid = round2(paidAmount + principalPending);
				await clientConnection.query(
					"UPDATE installments SET amount = $1, paid_amount = $2, status = $3, paid_date = $4 WHERE id = $5",
					[newPaid, newPaid, "Pagada", paymentDateValue, inst.id]
				);
			}
			const totalsAfter = await clientConnection.query(
				"SELECT SUM(amount) as amount_total FROM installments WHERE loan_id = $1",
				[resolvedLoanId]
			);
			const updatedTotal = round2(totalsAfter.rows[0]?.amount_total ?? 0);
			await clientConnection.query(
				"UPDATE loans SET total_payable = $1, paid_total = $1, pending_total = $2, status = $3 WHERE id = $4",
				[updatedTotal, 0, "Finalizado", resolvedLoanId]
			);
		} else {
			let remaining = paymentAmount;
			const startNumber = installmentRow ? Number(installmentRow.number) : null;
			for (const inst of installments.rows) {
				if (remaining <= 0) break;
				if (startNumber !== null && Number(inst.number) < startNumber) continue;
				const pending = round2(Number(inst.amount) - Number(inst.paid_amount));
				if (pending <= 0) continue;
				const applied = remaining >= pending ? pending : remaining;
				const newPaid = round2(Number(inst.paid_amount) + applied);
				const status = newPaid >= Number(inst.amount) ? "Pagada" : inst.status;
				await clientConnection.query(
					"UPDATE installments SET paid_amount = $1, status = $2, paid_date = $3 WHERE id = $4",
					[newPaid, status, status === "Pagada" ? paymentDateValue : inst.paid_date, inst.id]
				);
				remaining = round2(remaining - applied);
			}
		}

		const capital = await clientConnection.query("SELECT amount FROM capital WHERE id = 1");
		const nextCapital = round2(Number(capital.rows[0].amount) + paymentAmount);
		await clientConnection.query("UPDATE capital SET amount = $1, updated_at = $2 WHERE id = 1", [
			nextCapital,
			nowIso(),
		]);
		await clientConnection.query(
			"INSERT INTO capital_movements (type, amount, loan_id, payment_id, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
			[
				payoffRequested ? "payoff" : "payment",
				paymentAmount,
				resolvedLoanId,
				paymentResult.rows[0].id,
				payoffRequested ? "Pago total registrado" : "Pago registrado",
				nowIso(),
			]
		);

		await clientConnection.query("COMMIT");
		await updateLoanTotalsAndStatus(resolvedLoanId);
		res.status(201).json({ id: paymentResult.rows[0].id, amount: paymentAmount });
	} catch (error) {
		await clientConnection.query("ROLLBACK");
		throw error;
	} finally {
		clientConnection.release();
	}
	});

	// Resumen de deudores con filtro opcional.
	app.get("/debtors", async (req, res) => {
	const { status, clientId } = req.query || {};
	const clauses = [];
	const params = [];
	if (status === "active") {
		clauses.push("loans.status = 'Activo'");
	} else if (status === "finished") {
		clauses.push("loans.status = 'Finalizado'");
	} else if (status === "morose") {
		clauses.push("loans.status = 'En mora'");
	}
	if (clientId) {
		clauses.push("clients.id = $" + (params.length + 1));
		params.push(clientId);
	}
	const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
	const rows = await query(
		`SELECT
			clients.id AS client_id,
			clients.full_name,
			clients.document,
			SUM(loans.amount) AS total_loaned,
			SUM(loans.paid_total) AS total_paid,
			SUM(loans.pending_total) AS total_pending,
			SUM(loans.total_payable) AS total_with_interest,
			SUM(CASE WHEN loans.status = 'Activo' THEN 1 ELSE 0 END) AS active_loans,
			SUM(CASE WHEN loans.status = 'En mora' THEN 1 ELSE 0 END) AS morose_loans
		FROM clients
		JOIN loans ON loans.client_id = clients.id
		${where}
		GROUP BY clients.id
		ORDER BY clients.full_name ASC`,
		params
	);

	const withInstallments = [];
	for (const row of rows.rows) {
		const installmentStats = await query(
			`SELECT
				SUM(CASE WHEN installments.status = 'Pagada' THEN 1 ELSE 0 END) AS paid_count,
				SUM(CASE WHEN installments.status = 'Pendiente' THEN 1 ELSE 0 END) AS pending_count,
				SUM(CASE WHEN installments.status = 'Atrasada' THEN 1 ELSE 0 END) AS late_count
			FROM installments
			JOIN loans ON installments.loan_id = loans.id
			WHERE loans.client_id = $1`,
			[row.client_id]
		);

		withInstallments.push({
			...row,
			installments_paid: Number(installmentStats.rows[0]?.paid_count ?? 0),
			installments_pending: Number(installmentStats.rows[0]?.pending_count ?? 0),
			installments_late: Number(installmentStats.rows[0]?.late_count ?? 0),
		});
	}

	res.json(withInstallments);
	});

	// Totales del dashboard.
	app.get("/dashboard", async (req, res) => {
		const capital = await getCapital();
		const totals = await query("SELECT SUM(amount) AS total_loaned, SUM(pending_total) AS total_pending FROM loans");
		const recovered = await query("SELECT SUM(amount) AS total_recovered FROM payments");
		const activeClients = await query(
			"SELECT COUNT(DISTINCT client_id) AS active_clients FROM loans WHERE status = 'Activo'"
		);
		const loansInMora = await query("SELECT COUNT(*) AS loans_in_mora FROM loans WHERE status = 'En mora'");

		res.json({
			capital_available: round2(Number(capital.amount)),
			total_loaned: round2(totals.rows[0]?.total_loaned ?? 0),
			total_pending: round2(totals.rows[0]?.total_pending ?? 0),
			total_recovered: round2(recovered.rows[0]?.total_recovered ?? 0),
			active_clients: Number(activeClients.rows[0]?.active_clients ?? 0),
			loans_in_mora: Number(loansInMora.rows[0]?.loans_in_mora ?? 0),
		});
	});

	// Endpoint de mantenimiento para normalizar fechas a quincenas.
	app.post("/maintenance/fix-installment-dates", async (req, res) => {
		const loans = await query("SELECT id, loan_date, installments_count FROM loans ORDER BY id ASC");
		let fixed = 0;
		for (const loan of loans.rows) {
			const installments = await query(
				"SELECT id, number, due_date FROM installments WHERE loan_id = $1 ORDER BY number ASC",
				[loan.id]
			);
			if (installments.rowCount <= 1) continue;
			const uniqueDates = new Set(installments.rows.map((row) => toDateOnly(row.due_date)));
			if (uniqueDates.size > 1) continue;
			const schedule = buildQuincenalSchedule(loan.loan_date, loan.installments_count);
			const clientConnection = await pool.connect();
			try {
				await clientConnection.query("BEGIN");
				for (let i = 0; i < installments.rows.length; i += 1) {
					await clientConnection.query("UPDATE installments SET due_date = $1 WHERE id = $2", [
						schedule[i],
						installments.rows[i].id,
					]);
				}
				await clientConnection.query("COMMIT");
				fixed += 1;
			} catch (error) {
				await clientConnection.query("ROLLBACK");
				throw error;
			} finally {
				clientConnection.release();
			}
		}
		res.json({ ok: true, loans_checked: loans.rowCount, loans_fixed: fixed });
	});

	// Inicia el servidor HTTP.
	const port = process.env.PORT || 3000;
	app.listen(port, () => {
		console.log(`API escuchando en puerto ${port}`);
	});
};

// Inicia el servidor y muestra errores fatales de arranque.
start().catch((error) => {
	console.error("Error iniciando API:", error);
	process.exit(1);
});
