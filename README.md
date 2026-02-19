# prestamos

API de préstamos con PostgreSQL.

## Requisitos

- PostgreSQL con base de datos llamada **prestamos**.

## Configuración

Variables soportadas:

- DATABASE_URL (opcional)
- DB_HOST (por defecto: localhost)
- DB_PORT (por defecto: 5432)
- DB_USER (por defecto: postgres)
- DB_PASSWORD (por defecto: postgres)
- DB_NAME (por defecto: prestamos)

## Ejecutar

```bash
npm install
npm start
```

## Frontend

Abrir http://localhost:3000 para usar el panel interactivo.

## Endpoints principales

- GET /health
- GET /capital
- PUT /capital
- POST /capital/adjust
- POST /clients
- GET /clients
- GET /clients/:id
- POST /loans
- GET /loans
- GET /loans/:id
- POST /payments
- GET /debtors
- GET /dashboard
