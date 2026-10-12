-- ==============================================================================
-- PROYECTO: GastosYa - Control de Gastos Multimoneda (Venezuela)
-- FASE: 4.1 - Persistencia y Migración a Supabase (PostgreSQL Relacional)
-- ARCHIVO: docs/schema.sql
-- DESCRIPCIÓN: Esquema DDL inicial con aislamiento total multitenant por usuario,
--              restricciones de integridad, índices de alto rendimiento,
--              Row Level Security (RLS) estricto y trigger de auto-inicialización.
-- ==============================================================================

-- Habilitar extensión pgcrypto para funciones criptográficas y UUIDs
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==============================================================================
-- 1. TABLA: categories
-- ==============================================================================
-- Almacena las categorías de gastos con aislamiento completo por usuario.
-- Cada usuario posee su propia copia editable/eliminable de categorías.
--
-- Reglas de negocio:
-- - user_id es obligatorio (NOT NULL) y referenciado a auth.users(id).
-- - is_default indica si la categoría fue generada por el sistema inicialmente.
-- - Unicidad por usuario: un usuario no puede tener dos categorías con el mismo nombre.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'tag',
    color TEXT NOT NULL DEFAULT '#64748b',
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Restricción de unicidad aislada por usuario
    CONSTRAINT uq_categories_user_name UNIQUE (user_id, name)
);

-- Documentación en catálogo de PostgreSQL
COMMENT ON TABLE public.categories IS 'Categorías de gastos con aislamiento total por usuario';
COMMENT ON COLUMN public.categories.id IS 'Identificador único universal de la categoría';
COMMENT ON COLUMN public.categories.user_id IS 'ID del usuario propietario en auth.users';
COMMENT ON COLUMN public.categories.name IS 'Nombre visible de la categoría (ej: Comida, Transporte)';
COMMENT ON COLUMN public.categories.icon IS 'Identificador o emoji representativo del icono';
COMMENT ON COLUMN public.categories.color IS 'Color hexadecimal de interfaz (#RRGGBB)';
COMMENT ON COLUMN public.categories.is_default IS 'Marca referencial que indica si fue inicializada por el sistema';
COMMENT ON COLUMN public.categories.created_at IS 'Marca temporal de creación del registro';

-- ==============================================================================
-- 2. TABLA: transactions
-- ==============================================================================
-- Registra cada gasto individual con inmutabilidad cambiaria histórica.
--
-- Reglas de negocio:
-- - amount_usd almacena el valor normalizado snapshot para analíticas O(1).
-- - rate_value y rate_type preservan la tasa aplicada al momento del gasto.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
    amount_original NUMERIC(14, 4) NOT NULL CHECK (amount_original > 0),
    currency TEXT NOT NULL CHECK (currency IN ('VES', 'USD', 'EUR', 'USDT')),
    rate_type TEXT NOT NULL CHECK (rate_type IN ('BCV', 'PARALELO', 'MANUAL', 'NONE')),
    rate_value NUMERIC(14, 4) NOT NULL DEFAULT 1.0000 CHECK (rate_value > 0),
    amount_usd NUMERIC(14, 4) NOT NULL CHECK (amount_usd > 0),
    note TEXT,
    spent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.transactions IS 'Registro inmutable de transacciones monetarias por usuario';
COMMENT ON COLUMN public.transactions.id IS 'Identificador único de la transacción';
COMMENT ON COLUMN public.transactions.user_id IS 'Usuario propietario referenciado a auth.users';
COMMENT ON COLUMN public.transactions.category_id IS 'Categoría asociada (SET NULL si el usuario la elimina)';
COMMENT ON COLUMN public.transactions.amount_original IS 'Monto pagado en divisa original (> 0)';
COMMENT ON COLUMN public.transactions.currency IS 'Divisa de origen (VES, USD, EUR, USDT)';
COMMENT ON COLUMN public.transactions.rate_type IS 'Referencia cambiaria (BCV, PARALELO, MANUAL, NONE)';
COMMENT ON COLUMN public.transactions.rate_value IS 'Valor de cotización aplicado al momento del registro (> 0)';
COMMENT ON COLUMN public.transactions.amount_usd IS 'Monto normalizado a USD snapshot al momento del gasto (> 0)';
COMMENT ON COLUMN public.transactions.note IS 'Descripción o comercio asociado';
COMMENT ON COLUMN public.transactions.spent_at IS 'Fecha y hora real del gasto';
COMMENT ON COLUMN public.transactions.created_at IS 'Fecha y hora de inserción en base de datos';

-- ==============================================================================
-- 3. TABLA: exchange_rates
-- ==============================================================================
-- Almacena las tasas de cambio de referencia (BCV y Paralelo).
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.exchange_rates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR', 'USDT')),
    rate_type TEXT NOT NULL CHECK (rate_type IN ('BCV', 'PARALELO')),
    rate_value NUMERIC(14, 4) NOT NULL CHECK (rate_value > 0),
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.exchange_rates IS 'Historial de cotizaciones de tasas de cambio';
COMMENT ON COLUMN public.exchange_rates.id IS 'Identificador único de la tasa';
COMMENT ON COLUMN public.exchange_rates.currency IS 'Divisa cotizada (USD, EUR, USDT)';
COMMENT ON COLUMN public.exchange_rates.rate_type IS 'Tipo de tasa (BCV, PARALELO)';
COMMENT ON COLUMN public.exchange_rates.rate_value IS 'Valor de la tasa en bolívares (> 0)';
COMMENT ON COLUMN public.exchange_rates.fetched_at IS 'Marca temporal de actualización';

-- ==============================================================================
-- 4. ÍNDICES DE RENDIMIENTO (Performance Indexes)
-- ==============================================================================

-- 4.1 Historial cronológico y filtros analíticos por usuario
CREATE INDEX IF NOT EXISTS idx_transactions_user_spent 
    ON public.transactions(user_id, spent_at DESC);

-- 4.2 Listado de categorías pertenecientes a un usuario
CREATE INDEX IF NOT EXISTS idx_categories_user_id 
    ON public.categories(user_id);

-- 4.3 Optimización de joins y ON DELETE SET NULL en transacciones
CREATE INDEX IF NOT EXISTS idx_transactions_category_id 
    ON public.transactions(category_id);

-- 4.4 Búsqueda de la última tasa de cambio disponible por divisa y tipo
CREATE INDEX IF NOT EXISTS idx_exchange_rates_lookup 
    ON public.exchange_rates(currency, rate_type, fetched_at DESC);

-- ==============================================================================
-- 5. ROW LEVEL SECURITY (RLS) - AISLAMIENTO TOTAL POR USUARIO
-- ==============================================================================

-- Habilitar RLS en todas las tablas
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------------
-- 5.1 Políticas para public.categories (Aislamiento Estricto por Usuario)
-- ------------------------------------------------------------------------------

-- SELECT: El usuario solo visualiza sus propias categorías
DROP POLICY IF EXISTS "categories_select_policy" ON public.categories;
CREATE POLICY "categories_select_policy"
    ON public.categories
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- INSERT: El usuario solo inserta categorías asignadas a su propio user_id
DROP POLICY IF EXISTS "categories_insert_policy" ON public.categories;
CREATE POLICY "categories_insert_policy"
    ON public.categories
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

-- UPDATE: El usuario puede modificar libremente cualquiera de sus categorías
DROP POLICY IF EXISTS "categories_update_policy" ON public.categories;
CREATE POLICY "categories_update_policy"
    ON public.categories
    FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- DELETE: El usuario puede eliminar libremente cualquiera de sus categorías
DROP POLICY IF EXISTS "categories_delete_policy" ON public.categories;
CREATE POLICY "categories_delete_policy"
    ON public.categories
    FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- ------------------------------------------------------------------------------
-- 5.2 Políticas para public.transactions (Aislamiento Estricto por Usuario)
-- ------------------------------------------------------------------------------

-- SELECT: El usuario solo visualiza sus propios movimientos
DROP POLICY IF EXISTS "transactions_select_policy" ON public.transactions;
CREATE POLICY "transactions_select_policy"
    ON public.transactions
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- INSERT: El usuario solo registra transacciones a su nombre
DROP POLICY IF EXISTS "transactions_insert_policy" ON public.transactions;
CREATE POLICY "transactions_insert_policy"
    ON public.transactions
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

-- UPDATE: El usuario solo actualiza transacciones propias
DROP POLICY IF EXISTS "transactions_update_policy" ON public.transactions;
CREATE POLICY "transactions_update_policy"
    ON public.transactions
    FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- DELETE: El usuario solo elimina transacciones propias
DROP POLICY IF EXISTS "transactions_delete_policy" ON public.transactions;
CREATE POLICY "transactions_delete_policy"
    ON public.transactions
    FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- ------------------------------------------------------------------------------
-- 5.3 Políticas para public.exchange_rates
-- ------------------------------------------------------------------------------

-- SELECT: Lectura global para cualquier usuario autenticado
DROP POLICY IF EXISTS "exchange_rates_select_policy" ON public.exchange_rates;
CREATE POLICY "exchange_rates_select_policy"
    ON public.exchange_rates
    FOR SELECT
    TO authenticated
    USING (true);

-- INSERT / UPDATE / DELETE: Reservado exclusivamente para service_role (backend/crons)
DROP POLICY IF EXISTS "exchange_rates_service_role_policy" ON public.exchange_rates;
CREATE POLICY "exchange_rates_service_role_policy"
    ON public.exchange_rates
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ==============================================================================
-- 6. TRIGGER DE AUTO-INICIALIZACIÓN (Seed de Categorías por Usuario)
-- ==============================================================================
-- Cuando un nuevo usuario se registra en auth.users, esta función se ejecuta con
-- privilegios elevados (SECURITY DEFINER) para sembrar su set inicial de 6 categorías.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user_categories()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.categories (user_id, name, icon, color, is_default)
    VALUES
        (NEW.id, 'Comida',     '🍔', '#f59e0b', true),
        (NEW.id, 'Mercado',    '🛒', '#10b981', true),
        (NEW.id, 'Transporte', '🚗', '#3b82f6', true),
        (NEW.id, 'Servicios',  '💡', '#8b5cf6', true),
        (NEW.id, 'Farmacia',   '💊', '#ec4899', true),
        (NEW.id, 'Otros',      '📦', '#64748b', true)
    ON CONFLICT (user_id, name) DO NOTHING;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user_categories() 
    IS 'Siembra automáticamente las 6 categorías iniciales para cada nuevo usuario en auth.users';

-- Asociar el trigger al evento AFTER INSERT de la tabla auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user_categories();

-- ==============================================================================
-- 7. MIGRACIÓN / RETROCOMPATIBILIDAD DE USUARIOS EXISTENTES
-- ==============================================================================
-- Si ya existen usuarios registrados en auth.users antes de correr este script,
-- se inicializan sus categorías por defecto de forma idempotente.
-- ==============================================================================
INSERT INTO public.categories (user_id, name, icon, color, is_default)
SELECT 
    u.id, 
    defaults.name, 
    defaults.icon, 
    defaults.color, 
    true
FROM auth.users u
CROSS JOIN (
    VALUES
        ('Comida',     '🍔', '#f59e0b'),
        ('Mercado',    '🛒', '#10b981'),
        ('Transporte', '🚗', '#3b82f6'),
        ('Servicios',  '💡', '#8b5cf6'),
        ('Farmacia',   '💊', '#ec4899'),
        ('Otros',      '📦', '#64748b')
) AS defaults(name, icon, color)
ON CONFLICT (user_id, name) DO NOTHING;
