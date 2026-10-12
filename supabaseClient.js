/**
 * ============================================================================
 * GastosYa - Cliente Oficial de Supabase (Fase 4.2)
 * ============================================================================
 * Inicializa y expone el cliente de Supabase para autenticación y persistencia
 * reactiva en toda la aplicación.
 * ============================================================================
 */

// ============================================================================
// CONFIGURACIÓN DE CREDENCIALES DE SUPABASE
// Reemplaza los siguientes valores con las credenciales de tu proyecto Supabase:
// (Disponibles en: Supabase Dashboard > Project Settings > API)
// ============================================================================
const SUPABASE_URL = 'https://vahjbamwhbheqiaecobm.supabase.co'; // <-- LÍNEA 16: Tu URL de Supabase
const SUPABASE_ANON_KEY = 'sb_publishable_BxjRFrL69KvQ-Hj46aovFQ_IrlZdo0f';           // <-- LÍNEA 17: Tu anon/public API Key

let client = null;

if (typeof window !== 'undefined') {
  // Verificar si la biblioteca oficial de Supabase está cargada vía CDN
  if (typeof window.supabase !== 'undefined' && typeof window.supabase.createClient === 'function') {
    try {
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      window.supabaseClient = client;
      console.log('⚡ [GastosYa] Cliente de Supabase inicializado correctamente.');
    } catch (err) {
      console.warn('⚠️ [GastosYa] Error al instanciar el cliente de Supabase:', err);
    }
  } else {
    console.warn('⚠️ [GastosYa] La librería @supabase/supabase-js no se detectó en window.supabase.');
  }
}

// Exportar globalmente para consumo de la aplicación
window.SUPABASE_URL = SUPABASE_URL;
window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
window.supabaseClient = client;
