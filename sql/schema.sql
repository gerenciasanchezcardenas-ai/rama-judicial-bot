-- ============================================================
-- PERFIL JURÍDICO Y PATRIMONIAL — Sánchez & Cárdenas Consulting
-- Ejecutar una sola vez en Supabase: SQL Editor → New query → Run
-- Tablas nuevas con prefijo pjp_ para no tocar las del portal.
-- ============================================================

-- Conversación en curso de cada número de WhatsApp
create table if not exists pjp_sesiones (
  telefono    text primary key,
  paso        text not null default 'inicio',
  datos       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Cada consulta: datos del consultado, hallazgos, pago y entregas
create table if not exists pjp_solicitudes (
  id                 bigint generated always as identity primary key,
  referencia         text not null unique,
  token_reporte      text not null unique,
  telefono           text not null,
  tipo_persona       text not null check (tipo_persona in ('nat','jur')),
  nombre             text not null,
  tipo_documento     text not null,
  documento          text not null,
  acepto_terminos_at timestamptz not null,
  resultado_rama     jsonb,
  resultado_secop    jsonb,
  valor_centavos     integer not null,
  estado             text not null default 'pendiente_pago'
                     check (estado in ('pendiente_pago','pagado','reporte_enviado',
                                       'complemento_enviado','anulado')),
  wompi_transaccion  text,
  pagado_at          timestamptz,
  reporte_enviado_at timestamptz,
  snr_vence_at       timestamptz,
  snr_resultado      text,
  snr_matriculas     jsonb,
  snr_cargado_por    text,
  complemento_at     timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists pjp_solicitudes_estado_idx on pjp_solicitudes (estado);
create index if not exists pjp_solicitudes_telefono_idx on pjp_solicitudes (telefono);

-- Solo el servidor (llave service_role) lee y escribe estas tablas.
alter table pjp_sesiones    enable row level security;
alter table pjp_solicitudes enable row level security;
