// Cliente API delgado basado en fetch.
const api = {
  async get(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async put(path, body) {
    const res = await fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async del(path) {
    const res = await fetch(path, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
};

// Helpers de UI para toast, moneda y fechas.
const ui = {
  toast(message, type = "success") {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    setTimeout(() => toast.classList.remove("show"), 2600);
  },
  money(value) {
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: "COP",
      maximumFractionDigits: 0,
    }).format(Number(value ?? 0));
  },
  dateLong(value) {
    if (!value) return "";
    return new Date(value).toLocaleDateString("es-CO", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  },
};

// Redondeo para calculos de UI y totales derivados.
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// Estado en memoria para la UI.
const state = {
  clients: [],
  loans: [],
  payments: [],
  debtorsFilter: "all",
};

let appStarted = false;
const AUTH_USER = "admin";
const AUTH_PASS = "admin1205";
const AUTH_KEY = "prestamos.admin.auth";

// Componente modal reutilizable con campos dinamicos.
const modal = {
  root: document.getElementById("modal"),
  title: document.getElementById("modal-title"),
  form: document.getElementById("modal-form"),
  submit: document.getElementById("btn-submit"),
  footer: document.querySelector(".modal-footer"),
  cancel: document.getElementById("btn-cancel"),
  open(config) {
    this.title.textContent = config.title;
    this.form.innerHTML = "";
    if (config.fields) {
      config.fields.forEach((field) => {
        const wrapper = document.createElement("div");
        wrapper.className = "field";
        wrapper.innerHTML = `
          <label>${field.label}</label>
          ${field.type === "textarea" ? `<textarea name="${field.name}" ${field.required ? "required" : ""}>${field.value ?? ""}</textarea>` :
          field.type === "select" ? `<select name="${field.name}" ${field.required ? "required" : ""}>${field.options.map((opt) => `<option value="${opt.value}" ${field.value === opt.value ? "selected" : ""}>${opt.label}</option>`).join("")}</select>` :
          `<input type="${field.type}" name="${field.name}" value="${field.value ?? ""}" ${field.required ? "required" : ""} />`}
        `;
        this.form.appendChild(wrapper);
      });
    } else if (config.content) {
      this.form.innerHTML = config.content;
    }
    this.onSubmit = config.onSubmit;
    this.submit.textContent = config.submitText ?? "Guardar";
    this.cancel.textContent = config.cancelText ?? "Cancelar";
    this.submit.style.display = config.hideSubmit ? "none" : "";
    this.root.classList.add("open");
  },
  close() {
    this.root.classList.remove("open");
    this.form.innerHTML = "";
    this.submit.style.display = "";
    this.submit.textContent = "Guardar";
    this.cancel.textContent = "Cancelar";
    this.onSubmit = null;
  },
};

// Helper para cerrar el modal.
const closeModal = () => modal.close();

// Acciones de cierre del modal.
document.getElementById("btn-close-modal").addEventListener("click", closeModal);
document.getElementById("btn-cancel").addEventListener("click", closeModal);

// Refresca las tarjetas de resumen del dashboard.
const refreshDashboard = async () => {
  const [capital, dashboard] = await Promise.all([api.get("/capital"), api.get("/dashboard")]);
  document.getElementById("capital-available").textContent = ui.money(capital.amount);
  document.getElementById("capital-updated").textContent = `Última actualización: ${new Date(
    capital.updated_at
  ).toLocaleString()}`;
  document.getElementById("total-loaned").textContent = ui.money(dashboard.total_loaned);
  document.getElementById("total-pending").textContent = ui.money(dashboard.total_pending);
  document.getElementById("total-recovered").textContent = ui.money(dashboard.total_recovered);
  document.getElementById("active-clients").textContent = dashboard.active_clients;
  document.getElementById("loans-mora").textContent = dashboard.loans_in_mora;
};

// Renderiza el listado reciente de clientes.
const renderClients = () => {
  const container = document.getElementById("clients-list");
  container.innerHTML = "";
  if (state.clients.length === 0) {
    container.innerHTML = "<div class='row'><span>No hay clientes registrados</span></div>";
    return;
  }
  state.clients.slice(0, 6).forEach((client) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div>
        <strong>${client.full_name}</strong>
        <small>${client.document} · ${client.phone}</small>
      </div>
      <div class="row-actions">
        <button class="btn ghost small" type="button" data-action="view">Ver créditos</button>
          <button class="btn ghost small danger" type="button" data-action="delete">Eliminar</button>
        <span class="badge">ID ${client.id}</span>
      </div>
    `;
      row.querySelector("[data-action='view']").addEventListener("click", () =>
        openClientLoans(client.id, client.full_name)
      );
      row.querySelector("[data-action='delete']").addEventListener("click", async () => {
        if (!confirm(`¿Eliminar el cliente ${client.full_name}? También se eliminarán sus créditos.`)) return;
        try {
          await api.del(`/clients/${client.id}`);
          ui.toast("Cliente eliminado");
          await refreshAll();
        } catch (error) {
          const message = error?.message ? error.message : "No se pudo eliminar el cliente";
          ui.toast(message, "error");
        }
      });
    container.appendChild(row);
  });
};

// Renderiza el listado reciente de prestamos.
const renderLoans = () => {
  const container = document.getElementById("loans-list");
  container.innerHTML = "";
  if (state.loans.length === 0) {
    container.innerHTML = "<div class='row'><span>No hay préstamos registrados</span></div>";
    return;
  }
  state.loans.slice(0, 6).forEach((loan) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div>
        <strong>${ui.money(loan.amount)} · ${loan.client_name ?? ""}</strong>
        <small>${ui.dateLong(loan.loan_date)} · ${loan.installments_count} cuotas</small>
      </div>
      <div class="row-actions">
        <button class="btn ghost small" type="button" data-action="status">Cambiar estado</button>
        <button class="btn ghost small danger" type="button" data-action="delete">Eliminar</button>
        <span class="badge ${loan.status === "En mora" ? "danger" : loan.status === "Finalizado" ? "success" : "warning"}">${loan.status}</span>
      </div>
    `;
    row.querySelector("[data-action='status']").addEventListener("click", () => openLoanStatusModal(loan));
    row.querySelector("[data-action='delete']").addEventListener("click", async () => {
      if (!confirm(`¿Eliminar el préstamo #${loan.id}?`)) return;
      try {
        await api.del(`/loans/${loan.id}`);
        ui.toast("Préstamo eliminado");
        await refreshAll();
      } catch (error) {
        const message = error?.message ? error.message : "No se pudo eliminar el préstamo";
        ui.toast(message, "error");
      }
    });
    container.appendChild(row);
  });
};

// Renderiza el historial reciente de pagos.
const renderPayments = () => {
  const container = document.getElementById("payments-list");
  container.innerHTML = "";
  if (state.payments.length === 0) {
    container.innerHTML = "<div class='row'><span>No hay pagos registrados</span></div>";
    return;
  }
  state.payments.slice(0, 6).forEach((payment) => {
    const row = document.createElement("div");
    const typeLabel = payment.type === "payoff" ? "Pago total" : "Pago";
    row.className = "row";
    row.innerHTML = `
      <div>
        <strong>${ui.money(payment.amount)} · ${payment.client_name ?? ""}</strong>
        <small>${ui.dateLong(payment.payment_date)} · Préstamo #${payment.loan_id}</small>
      </div>
      <div class="row-actions">
        <span class="badge ${payment.type === "payoff" ? "success" : "warning"}">${typeLabel}</span>
      </div>
    `;
    container.appendChild(row);
  });
};

// Renderiza la vista de deudores con filtros.
const renderDebtors = async () => {
  const filter = state.debtorsFilter;
  const query = filter === "all" || filter === "interest" ? "" : `?status=${filter}`;
  const list = await api.get(`/debtors${query}`);
  const container = document.getElementById("debtors-list");
  container.innerHTML = "";
  if (list.length === 0) {
    container.innerHTML = "<div class='row'><span>No hay deudores en esta vista</span></div>";
    return;
  }
  list.forEach((debtor) => {
    const row = document.createElement("div");
    row.className = "row";
    if (filter === "interest") {
      row.innerHTML = `
        <div>
          <strong>${debtor.full_name}</strong>
          <small>Total con interés 5%: ${ui.money(debtor.total_with_interest)}</small>
        </div>
        <div class="row-actions">
          <button class="btn ghost small" type="button">Ver créditos</button>
          <span class="badge">${debtor.installments_paid} pagadas / ${debtor.installments_pending} pendientes</span>
        </div>
      `;
    } else {
      row.innerHTML = `
        <div>
          <strong>${debtor.full_name}</strong>
          <small>Pendiente: ${ui.money(debtor.total_pending)} · Pagado: ${ui.money(debtor.total_paid)}</small>
        </div>
        <div class="row-actions">
          <button class="btn ghost small" type="button">Ver créditos</button>
          <span class="badge">${debtor.installments_paid} pagadas / ${debtor.installments_pending} pendientes</span>
        </div>
      `;
    }
    row.querySelector("button").addEventListener("click", () => openClientLoans(debtor.client_id, debtor.full_name));
    container.appendChild(row);
  });
};

// Normaliza texto para busquedas simples sin tildes ni mayusculas.
const normalizeText = (value) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

// Renderiza resultados de busqueda por cliente.
const renderClientSearchResults = async (matches) => {
  const container = document.getElementById("client-search-results");
  container.innerHTML = "";

  if (matches.length === 0) {
    container.innerHTML = "<div class='row'><span>Sin resultados</span></div>";
    return;
  }

  matches.forEach((client) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div>
        <strong>${client.full_name}</strong>
        <small>${client.document} · ${client.phone}</small>
      </div>
      <div class="row-actions">
        <button class="btn ghost small" type="button">Ver informacion</button>
      </div>
    `;
    row.querySelector("button").addEventListener("click", () => {
      loadClientCreditDetail(client.id, client.full_name);
    });
    container.appendChild(row);
  });
};

// Carga y muestra el detalle completo del credito en el panel.
const loadClientCreditDetail = async (clientId, fullName) => {
  const container = document.getElementById("client-search-results");
  container.innerHTML = "<div class='row'><span>Cargando informacion...</span></div>";
  try {
    const loans = await api.get(`/loans?clientId=${clientId}`);
    if (!loans.length) {
      container.innerHTML = "<div class='row'><span>El cliente no tiene creditos.</span></div>";
      return;
    }
    const details = await Promise.all(loans.map((loan) => api.get(`/loans/${loan.id}`)));
    container.innerHTML = details
      .map((loan) => {
        const installments = loan.installments
          .map(
            (inst) => `
            <div class="installment-row">
              <span>Cuota ${inst.number} · ${ui.dateLong(inst.due_date)}</span>
              <span>${ui.money(inst.amount)} · ${inst.status}</span>
            </div>
          `
          )
          .join("");
        const payments = loan.payments
          .map(
            (payment) => `
            <div class="installment-row">
              <span>${ui.dateLong(payment.payment_date)} · ${payment.type === "payoff" ? "Pago total" : "Pago"}</span>
              <span>${ui.money(payment.amount)}</span>
            </div>
          `
          )
          .join("");
        return `
          <div class="loan-card">
            <div class="loan-header">
              <div>
                <strong>${fullName} · Préstamo #${loan.id}</strong>
                <small>${ui.dateLong(loan.loan_date)} · ${loan.installments_count} cuotas</small>
              </div>
              <span class="badge ${loan.status === "En mora" ? "danger" : loan.status === "Finalizado" ? "success" : "warning"}">${loan.status}</span>
            </div>
            <div class="loan-meta">
              <span>Prestado: ${ui.money(loan.amount)}</span>
              <span>Total con interés: ${ui.money(loan.total_payable)}</span>
              <span>Pagado: ${ui.money(loan.paid_total)}</span>
              <span>Pendiente: ${ui.money(loan.pending_total)}</span>
            </div>
            <div class="installments-list">
              ${installments}
              ${payments ? `<div class="installment-row"><span>Pagos registrados</span><span></span></div>${payments}` : ""}
            </div>
          </div>
        `;
      })
      .join("");
  } catch (error) {
    container.innerHTML = "<div class='row'><span>Error cargando informacion.</span></div>";
  }
};

// Configura la busqueda por nombre en el nuevo panel.
const setupClientSearch = () => {
  const input = document.getElementById("client-search-input");
  const clear = document.getElementById("client-search-clear");
  const results = document.getElementById("client-search-results");

  const renderEmpty = () => {
    results.innerHTML = "<div class='row'><span>Escribe un nombre para buscar.</span></div>";
  };

  const handleSearch = () => {
    const term = normalizeText(input.value.trim());
    if (!term) {
      renderEmpty();
      return;
    }
    const matches = state.clients.filter((client) =>
      normalizeText(client.full_name).includes(term)
    );
    renderClientSearchResults(matches);
  };

  input.addEventListener("input", handleSearch);
  clear.addEventListener("click", () => {
    input.value = "";
    renderEmpty();
  });

  renderEmpty();
};

// Abre un modal con los creditos y cuotas de un cliente.
const openClientLoans = async (clientId, fullName) => {
  modal.open({
    title: `Créditos de ${fullName}`,
    content: "<div id=\"client-loans-detail\" class=\"detail-list\">Cargando créditos...</div>",
    hideSubmit: true,
    cancelText: "Cerrar",
  });
  const container = document.getElementById("client-loans-detail");
  try {
    const loans = await api.get(`/loans?clientId=${clientId}`);
    if (!loans.length) {
      container.innerHTML = "<div class='row'><span>No hay créditos registrados para este cliente.</span></div>";
      return;
    }
    const details = await Promise.all(loans.map((loan) => api.get(`/loans/${loan.id}`)));
    container.innerHTML = details
      .map((loan) => {
        const installments = loan.installments
          .map(
            (inst) => `
            <div class="installment-row">
              <span>Cuota ${inst.number} · ${ui.dateLong(inst.due_date)}</span>
              <span>${ui.money(inst.amount)} · ${inst.status}</span>
            </div>
          `
          )
          .join("");
        return `
          <div class="loan-card">
            <div class="loan-header">
              <div>
                <strong>Préstamo #${loan.id}</strong>
                <small>${ui.dateLong(loan.loan_date)} · ${loan.installments_count} cuotas</small>
              </div>
              <span class="badge ${loan.status === "En mora" ? "danger" : loan.status === "Finalizado" ? "success" : "warning"}">${loan.status}</span>
            </div>
            <div class="loan-meta">
              <span>Prestado: ${ui.money(loan.amount)}</span>
              <span>Total con interés: ${ui.money(loan.total_payable)}</span>
            </div>
            <div class="installments-list">${installments}</div>
          </div>
        `;
      })
      .join("");
  } catch (error) {
    container.innerHTML = "<div class='row'><span>Error cargando los créditos.</span></div>";
  }
};

// Abre el modal para actualizar el estado del prestamo.
const openLoanStatusModal = (loan) => {
  modal.open({
    title: `Cambiar estado · Préstamo #${loan.id}`,
    fields: [
      {
        label: "Estado",
        name: "status",
        type: "select",
        required: true,
        value: loan.status,
        options: [
          { value: "Activo", label: "Activo" },
          { value: "Finalizado", label: "Finalizado" },
          { value: "En mora", label: "En mora" },
        ],
      },
    ],
    submitText: "Actualizar",
    onSubmit: async (data) => {
      try {
        await api.put(`/loans/${loan.id}/status`, { status: data.status });
        ui.toast("Estado actualizado");
        await refreshAll();
      } catch (error) {
        const message = error?.message ? error.message : "No se pudo actualizar el estado";
        ui.toast(message, "error");
        throw error;
      }
    },
  });
};

// Refresca listados (clientes, prestamos, pagos) y deudores.
const refreshLists = async () => {
  const [clients, loans, payments] = await Promise.all([
    api.get("/clients"),
    api.get("/loans"),
    api.get("/payments"),
  ]);
  state.clients = clients;
  state.loans = loans;
  state.payments = payments;
  renderClients();
  renderLoans();
  renderPayments();
  await renderDebtors();
};

// Abre el modal para actualizar el capital disponible.
const openCapitalModal = () => {
  modal.open({
    title: "Configurar capital",
    fields: [{ label: "Capital disponible", name: "amount", type: "number", required: true }],
    onSubmit: async (data) => {
      await api.put("/capital", { amount: Number(data.amount) });
      ui.toast("Capital actualizado");
      await refreshAll();
    },
  });
};

// Abre el modal para registrar un nuevo cliente.
const openClientModal = () => {
  modal.open({
    title: "Nuevo cliente",
    fields: [
      { label: "Nombre completo", name: "fullName", type: "text", required: true },
      { label: "Documento", name: "document", type: "text", required: true },
      { label: "Teléfono", name: "phone", type: "text", required: true },
      { label: "Dirección", name: "address", type: "text" },
    ],
    onSubmit: async (data) => {
      await api.post("/clients", data);
      ui.toast("Cliente registrado");
      await refreshAll();
    },
  });
};

// Abre el modal para crear un nuevo prestamo.
const openLoanModal = () => {
  modal.open({
    title: "Nuevo préstamo",
    fields: [
      {
        label: "Cliente",
        name: "clientId",
        type: "select",
        required: true,
        options: state.clients.map((client) => ({
          label: `${client.full_name} (ID ${client.id})`,
          value: client.id,
        })),
      },
      { label: "Monto prestado", name: "amount", type: "number", required: true },
      { label: "Fecha del préstamo", name: "loanDate", type: "date", required: true },
      { label: "Número de cuotas", name: "installmentsCount", type: "number", required: true },
      { label: "Observaciones", name: "notes", type: "textarea" },
    ],
    onSubmit: async (data) => {
      await api.post("/loans", {
        clientId: Number(data.clientId),
        amount: Number(data.amount),
        loanDate: data.loanDate,
        installmentsCount: Number(data.installmentsCount),
        notes: data.notes,
      });
      ui.toast("Préstamo creado");
      await refreshAll();
    },
  });
};

// Abre el modal para registrar un pago o pago total.
const openPaymentModal = () => {
  modal.open({
    title: "Registrar pago",
    fields: [
      {
        label: "Préstamo",
        name: "loanId",
        type: "select",
        required: true,
        options: state.loans.map((loan) => ({
          label: `${loan.client_name ?? "Sin nombre"} · ${ui.money(loan.amount)} · ${loan.status}`,
          value: loan.id,
        })),
      },
      {
        label: "Cuota",
        name: "installmentId",
        type: "select",
        required: false,
        options: [{ label: "Selecciona un préstamo", value: "" }],
      },
      {
        label: "Tipo de pago",
        name: "paymentType",
        type: "select",
        required: true,
        options: [
          { value: "normal", label: "Normal" },
          { value: "payoff", label: "Pago total (sin intereses restantes)" },
        ],
      },
      { label: "Valor pagado", name: "amount", type: "number", required: true },
      { label: "Fecha de pago", name: "paymentDate", type: "date", required: true },
      { label: "Observaciones", name: "notes", type: "textarea" },
    ],
    onSubmit: async (data) => {
      const installmentId = data.installmentId ? Number(data.installmentId) : null;
      const payoff = data.paymentType === "payoff";
      await api.post("/payments", {
        loanId: Number(data.loanId),
        installmentId,
        amount: Number(data.amount),
        paymentDate: data.paymentDate,
        notes: data.notes,
        payoff,
      });
      ui.toast("Pago registrado");
      try {
        await refreshDashboard();
      } catch (error) {
        ui.toast("Pago registrado, pero no se pudo actualizar el capital", "error");
      }
      try {
        await refreshLists();
      } catch (error) {
        ui.toast("Pago registrado, pero no se pudieron actualizar los listados", "error");
      }
    },
  });

  // Elementos del formulario usados por la logica de pagos.
  const loanSelect = modal.form.querySelector("select[name='loanId']");
  const installmentSelect = modal.form.querySelector("select[name='installmentId']");
  const paymentTypeSelect = modal.form.querySelector("select[name='paymentType']");
  const amountInput = modal.form.querySelector("input[name='amount']");

  // Carga cuotas del prestamo y calcula pendientes y pago total.
  const loadInstallments = async (loanId) => {
    installmentSelect.innerHTML = "<option value=\"\">Cargando cuotas...</option>";
    try {
      const loan = await api.get(`/loans/${loanId}`);
      const baseInstallment = Number(loan.base_installment);
      const interestPerInstallment = Number(loan.interest_per_installment);
      const pending = loan.installments
        .map((inst) => ({
          ...inst,
          pendingAmount: Math.max(0, Number(inst.amount) - Number(inst.paid_amount ?? 0)),
        }))
        .filter((inst) => inst.pendingAmount > 0);
      const loanPendingTotal = pending.reduce((sum, inst) => sum + inst.pendingAmount, 0);
      const payoffTotal = round2(
        loan.installments.reduce((sum, inst) => {
          const paidAmount = Number(inst.paid_amount ?? 0);
          const principalPaid = Math.min(
            baseInstallment,
            Math.max(0, paidAmount - interestPerInstallment)
          );
          const principalPending = Math.max(0, baseInstallment - principalPaid);
          return sum + principalPending;
        }, 0)
      );
      if (pending.length === 0) {
        installmentSelect.innerHTML = "<option value=\"\">Sin cuotas pendientes</option>";
        amountInput.value = "";
        amountInput.removeAttribute("max");
        amountInput.dataset.loanPending = "";
        amountInput.dataset.payoffTotal = String(payoffTotal);
        return;
      }
      installmentSelect.innerHTML = pending
        .map(
          (inst) =>
            `<option value="${inst.id}">Cuota ${inst.number} · ${ui.dateLong(inst.due_date)} · ${ui.money(
              inst.pendingAmount
            )}</option>`
        )
        .join("");
      pending.forEach((inst) => {
        const option = installmentSelect.querySelector(`option[value="${inst.id}"]`);
        if (option) option.dataset.pending = String(inst.pendingAmount);
      });
      installmentSelect.value = pending[0].id;
      amountInput.value = Number(pending[0].pendingAmount);
      amountInput.max = String(loanPendingTotal);
      amountInput.dataset.loanPending = String(loanPendingTotal);
      amountInput.dataset.payoffTotal = String(payoffTotal);
    } catch (error) {
      installmentSelect.innerHTML = "<option value=\"\">Error cargando cuotas</option>";
      amountInput.value = "";
      amountInput.removeAttribute("max");
      amountInput.dataset.loanPending = "";
      amountInput.dataset.payoffTotal = "";
    }
  };

  // Carga cuotas para la seleccion inicial.
  if (loanSelect?.value) {
    loadInstallments(loanSelect.value);
  }
  // Refresca cuotas cuando cambia el prestamo.
  loanSelect?.addEventListener("change", (event) => {
    const selected = event.target.value;
    if (selected) {
      loadInstallments(selected);
    }
  });

  // Monto por defecto cuando se selecciona una cuota.
  installmentSelect?.addEventListener("change", () => {
    const selectedOption = installmentSelect.options[installmentSelect.selectedIndex];
    if (!selectedOption) return;
    const pendingAmount = Number(selectedOption.dataset.pending);
    const loanPendingTotal = Number(amountInput.dataset.loanPending);
    if (Number.isFinite(pendingAmount) && pendingAmount > 0) {
      amountInput.value = pendingAmount;
      if (Number.isFinite(loanPendingTotal) && loanPendingTotal > 0) {
        amountInput.max = String(loanPendingTotal);
      }
    }
  });

  // Alterna entre pago normal y pago total.
  paymentTypeSelect?.addEventListener("change", () => {
    const isPayoff = paymentTypeSelect.value === "payoff";
    if (isPayoff) {
      const payoffTotal = Number(amountInput.dataset.payoffTotal);
      if (Number.isFinite(payoffTotal) && payoffTotal > 0) {
        amountInput.value = payoffTotal;
        amountInput.max = String(payoffTotal);
      }
      installmentSelect.value = "";
      installmentSelect.disabled = true;
      amountInput.readOnly = true;
    } else {
      installmentSelect.disabled = false;
      amountInput.readOnly = false;
      const selectedOption = installmentSelect.options[installmentSelect.selectedIndex];
      const pendingAmount = Number(selectedOption?.dataset.pending);
      const loanPendingTotal = Number(amountInput.dataset.loanPending);
      if (Number.isFinite(pendingAmount) && pendingAmount > 0) {
        amountInput.value = pendingAmount;
      }
      if (Number.isFinite(loanPendingTotal) && loanPendingTotal > 0) {
        amountInput.max = String(loanPendingTotal);
      }
    }
  });
};

// Refresco completo de dashboard y listados.
const refreshAll = async () => {
  document.body.classList.add("loading");
  try {
    await refreshDashboard();
    await refreshLists();
  } catch (error) {
    ui.toast("Error cargando datos", "error");
  } finally {
    document.body.classList.remove("loading");
  }
};

// Conecta los filtros de deudores.
const setupFilters = () => {
  const group = document.getElementById("debtors-filters");
  group.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    group.querySelectorAll(".chip").forEach((btn) => btn.classList.remove("active"));
    chip.classList.add("active");
    state.debtorsFilter = chip.dataset.filter;
    renderDebtors();
  });
};

// Configura la navegacion del menu lateral.
const setupNavigation = () => {
  const buttons = Array.from(document.querySelectorAll(".nav-item"));
  const pages = Array.from(document.querySelectorAll(".page"));

  const activate = (targetId) => {
    pages.forEach((page) => page.classList.toggle("active", page.id === targetId));
    buttons.forEach((btn) => btn.classList.toggle("active", btn.dataset.target === targetId));
  };

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      activate(btn.dataset.target);
    });
  });

  const initial = buttons.find((btn) => btn.classList.contains("active"));
  if (initial) {
    activate(initial.dataset.target);
  }
};

// Asocia acciones de UI con modales y envio.
const attachHandlers = () => {
  document.getElementById("btn-open-setup").addEventListener("click", openCapitalModal);
  document.getElementById("btn-open-client").addEventListener("click", openClientModal);
  document.getElementById("btn-open-loan").addEventListener("click", openLoanModal);
  document.getElementById("btn-open-payment").addEventListener("click", openPaymentModal);
  document.getElementById("btn-refresh").addEventListener("click", refreshAll);
  document.getElementById("btn-submit").addEventListener("click", (event) => {
    event.preventDefault();
    if (!modal.onSubmit) return;
    const data = Object.fromEntries(new FormData(modal.form).entries());
    modal
      .onSubmit(data)
      .then(() => modal.close())
      .catch((error) => {
        const message = error?.message ? error.message : "Error procesando la solicitud";
        ui.toast(message, "error");
      });
  });
};

// Punto de entrada de la UI.
const init = async () => {
  attachHandlers();
  setupFilters();
  setupNavigation();
  setupClientSearch();
  await refreshAll();
};

const setupAuthGate = () => {
  const appRoot = document.getElementById("app-root");
  const loginScreen = document.getElementById("login-screen");
  const loginForm = document.getElementById("login-form");
  const loginError = document.getElementById("login-error");
  const loginUser = document.getElementById("login-user");
  const logoutButton = document.getElementById("btn-logout");

  if (!appRoot || !loginScreen || !loginForm) {
    init();
    return;
  }

  const showLogin = () => {
    loginScreen.classList.add("active");
    appRoot.classList.add("app-hidden");
  };

  const showApp = () => {
    loginScreen.classList.remove("active");
    appRoot.classList.remove("app-hidden");
  };

  const startApp = async () => {
    if (appStarted) {
      await refreshAll();
      return;
    }
    appStarted = true;
    await init();
  };

  if (sessionStorage.getItem(AUTH_KEY) === "true") {
    showApp();
    startApp();
    return;
  }

  showLogin();

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(loginForm);
    const user = String(data.get("user") ?? "").trim();
    const pass = String(data.get("pass") ?? "");

    if (user === AUTH_USER && pass === AUTH_PASS) {
      sessionStorage.setItem(AUTH_KEY, "true");
      if (loginError) loginError.textContent = "";
      showApp();
      await startApp();
      loginForm.reset();
      return;
    }

    if (loginError) loginError.textContent = "Credenciales incorrectas.";
    loginForm.reset();
    loginUser?.focus();
  });

  logoutButton?.addEventListener("click", () => {
    sessionStorage.removeItem(AUTH_KEY);
    if (loginError) loginError.textContent = "";
    showLogin();
    loginForm.reset();
    loginUser?.focus();
  });
};

// Inicia la aplicacion con login.
setupAuthGate();
