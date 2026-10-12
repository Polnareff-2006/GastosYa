/**
 * ============================================================================
 * GastosYa - Gestor Automatizado de Tasas de Cambio (Fase 4.4)
 * ============================================================================
 * Consume las cotizaciones oficiales y de mercado de DolarApi Venezuela
 * (BCV USD, Paralelo, BCV EUR), gestiona el respaldo y caché en localStorage,
 * sincroniza opcionalmente con Supabase y preserva la edición manual del usuario.
 * ============================================================================
 */

'use strict';

const ratesManager = {
  storageKey: 'gastosya_cached_rates',
  timeoutMs: 7000,
  isFetching: false,

  // Endpoints públicos de la API
  endpoints: {
    bcv: 'https://ve.dolarapi.com/v1/dolares/oficial',
    paralelo: 'https://ve.dolarapi.com/v1/dolares/paralelo',
    eur: 'https://ve.dolarapi.com/v1/euros/oficial'
  },

  // Referencias cacheadas del DOM
  elements: {},

  /**
   * Inicializa el módulo de tasas de cambio
   */
  init() {
    this.cacheElements();
    this.bindEvents();

    // 1. Cargar inmediatamente desde la caché local para evitar parpadeos
    const hasCache = this.loadCachedRates();

    // 2. Si hay conexión a internet, obtener tasas frescas de inmediato
    if (typeof navigator === 'undefined' || navigator.onLine) {
      this.fetchExchangeRates(false);
    } else if (!hasCache) {
      this.updateTimestampText('Sin conexión (Tasas predeterminadas)');
    }

    // 3. Reintentar cuando se restablezca la conexión a internet
    window.addEventListener('online', () => {
      console.log('🌐 [ratesManager] Conexión detectada. Actualizando cotizaciones...');
      this.fetchExchangeRates(false);
    });
  },

  /**
   * Almacena referencias a los nodos del DOM
   */
  cacheElements() {
    this.elements = {
      btnRefresh: document.getElementById('btn-refresh-rates'),
      updatedTime: document.getElementById('rates-updated-time'),
      tagBcv: document.getElementById('rate-tag-bcv'),
      tagEur: document.getElementById('rate-tag-eur'),
      tagParalelo: document.getElementById('rate-tag-paralelo')
    };
  },

  /**
   * Registra eventos del usuario
   */
  bindEvents() {
    if (this.elements.btnRefresh) {
      this.elements.btnRefresh.addEventListener('click', () => {
        this.fetchExchangeRates(true);
      });
    }
  },

  /**
   * Carga las tasas guardadas previamente en localStorage
   * @returns {boolean} True si se encontraron datos en caché
   */
  loadCachedRates() {
    try {
      const cachedStr = localStorage.getItem(this.storageKey);
      if (!cachedStr) return false;

      const cached = JSON.parse(cachedStr);
      if (cached && cached.rates) {
        if (typeof window.state !== 'undefined') {
          if (cached.rates.BCV) window.state.rates.BCV = Number(cached.rates.BCV);
          if (cached.rates.PARALELO) window.state.rates.PARALELO = Number(cached.rates.PARALELO);
          if (cached.rates.BCV_EUR) window.state.rates.BCV_EUR = Number(cached.rates.BCV_EUR);
          if (cached.rates.EUR_USD) window.state.rates.EUR_USD = Number(cached.rates.EUR_USD);
        }

        this.updateTickerDOM();
        this.updateTimestampText(this.formatTimestamp(cached.lastUpdated, true));
        return true;
      }
    } catch (err) {
      console.warn('[ratesManager] Error leyendo caché de tasas:', err);
    }
    return false;
  },

  /**
   * Guarda las tasas en localStorage con timestamp
   */
  saveCachedRates(rates, timestamp) {
    try {
      const payload = {
        rates: {
          BCV: rates.BCV,
          PARALELO: rates.PARALELO,
          BCV_EUR: rates.BCV_EUR,
          EUR_USD: rates.EUR_USD
        },
        lastUpdated: timestamp || new Date().toISOString()
      };
      localStorage.setItem(this.storageKey, JSON.stringify(payload));
    } catch (err) {
      console.error('[ratesManager] Error guardando caché:', err);
    }
  },

  /**
   * Consulta las cotizaciones desde la API venezolana con timeout y control de errores
   * @param {boolean} manualTrigger Indica si fue activado manualmente por el usuario
   */
  async fetchExchangeRates(manualTrigger = false) {
    if (this.isFetching) return;
    this.isFetching = true;
    this.setLoadingState(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const fetchWithTimeout = async (url) => {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      };

      // Consultar en paralelo BCV USD, Paralelo y Euro Oficial
      const [bcvRes, paraleloRes, eurRes] = await Promise.allSettled([
        fetchWithTimeout(this.endpoints.bcv),
        fetchWithTimeout(this.endpoints.paralelo),
        fetchWithTimeout(this.endpoints.eur)
      ]);

      clearTimeout(timeoutId);

      let updatedAny = false;
      const currentRates = (typeof window.state !== 'undefined') ? window.state.rates : {
        BCV: 45.20,
        PARALELO: 52.10,
        BCV_EUR: 49.30,
        EUR_USD: 1.09
      };

      // 1. Tasa BCV Oficial USD
      if (bcvRes.status === 'fulfilled' && bcvRes.value && typeof bcvRes.value.promedio === 'number') {
        currentRates.BCV = Number(bcvRes.value.promedio);
        updatedAny = true;
      }

      // 2. Tasa Dólar Paralelo
      if (paraleloRes.status === 'fulfilled' && paraleloRes.value && typeof paraleloRes.value.promedio === 'number') {
        currentRates.PARALELO = Number(paraleloRes.value.promedio);
        updatedAny = true;
      }

      // 3. Tasa Euro BCV
      if (eurRes.status === 'fulfilled' && eurRes.value && typeof eurRes.value.promedio === 'number') {
        currentRates.BCV_EUR = Number(eurRes.value.promedio);
        updatedAny = true;
      } else if (updatedAny && currentRates.BCV > 0) {
        // Derivar Euro con paridad estimada si el endpoint del euro fallara
        currentRates.BCV_EUR = Number((currentRates.BCV * (currentRates.EUR_USD || 1.09)).toFixed(2));
      }

      // Recalcular factor cruzado EUR/USD
      if (currentRates.BCV > 0 && currentRates.BCV_EUR > 0) {
        currentRates.EUR_USD = Number((currentRates.BCV_EUR / currentRates.BCV).toFixed(4));
      }

      if (updatedAny) {
        const nowIso = new Date().toISOString();

        // Guardar en caché local
        this.saveCachedRates(currentRates, nowIso);

        // Actualizar visualmente el ticker y el texto de sincronización
        this.updateTickerDOM();
        this.updateTimestampText(this.formatTimestamp(nowIso, false));

        // Actualizar el formulario si el usuario NO está ingresando una tasa manual personalizada
        if (typeof window.state !== 'undefined' && window.state.currentRateType !== 'CUSTOM') {
          if (typeof window.render !== 'undefined') {
            window.render.rateValueInput();
            window.render.livePreview();
          }
        }

        // Intento silencioso de registro histórico en Supabase
        this.syncWithSupabase(currentRates, nowIso);

        console.log(`✅ [ratesManager] Tasas actualizadas exitosamente: BCV=${currentRates.BCV.toFixed(2)}, Paralelo=${currentRates.PARALELO.toFixed(2)}`);
      } else {
        throw new Error('No se pudo obtener ninguna tasa válida de los endpoints.');
      }
    } catch (err) {
      console.warn('⚠️ [ratesManager] No se pudo obtener tasas online:', err.message || err);
      // Fallback a caché local o valores por defecto
      const hasCache = this.loadCachedRates();
      if (hasCache) {
        this.updateTimestampText(manualTrigger ? 'Fallo al conectar (Usando caché)' : 'Modo Offline (Caché local)');
      } else {
        this.updateTimestampText('Sin conexión (Tasas base)');
      }
    } finally {
      clearTimeout(timeoutId);
      this.isFetching = false;
      this.setLoadingState(false);
    }
  },

  /**
   * Sincronización silenciosa con la tabla public.exchange_rates en Supabase
   */
  async syncWithSupabase(rates, timestamp) {
    const client = window.supabaseClient;
    const user = window.authManager?.currentUser;
    if (!client || !user) return;

    try {
      await client.from('exchange_rates').insert([
        {
          currency: 'USD',
          rate_type: 'BCV',
          rate_value: rates.BCV,
          fetched_at: timestamp
        },
        {
          currency: 'USD',
          rate_type: 'PARALELO',
          rate_value: rates.PARALELO,
          fetched_at: timestamp
        }
      ]);
    } catch (e) {
      // Manejo silencioso: si RLS o permisos rechazan la inserción, no se interrumpe al usuario
    }
  },

  /**
   * Actualiza los elementos numéricos del ticker en la interfaz
   */
  updateTickerDOM() {
    const rates = (typeof window.state !== 'undefined') ? window.state.rates : null;
    if (!rates) return;

    const bcvVal = document.querySelector('#rate-tag-bcv .rate-val');
    const eurVal = document.querySelector('#rate-tag-eur .rate-val');
    const parVal = document.querySelector('#rate-tag-paralelo .rate-val');

    if (bcvVal && rates.BCV) bcvVal.textContent = rates.BCV.toFixed(2);
    if (eurVal && rates.BCV_EUR) eurVal.textContent = rates.BCV_EUR.toFixed(2);
    if (parVal && rates.PARALELO) parVal.textContent = rates.PARALELO.toFixed(2);
  },

  /**
   * Actualiza el texto de fecha/hora de sincronización
   * @param {string} text
   */
  updateTimestampText(text) {
    if (this.elements.updatedTime) {
      this.elements.updatedTime.textContent = text;
      this.elements.updatedTime.title = text;
    }
  },

  /**
   * Muestra u oculta la animación de rotación en el botón de actualización
   * @param {boolean} loading
   */
  setLoadingState(loading) {
    const btn = this.elements.btnRefresh;
    if (!btn) return;

    btn.disabled = loading;
    if (loading) {
      btn.classList.add('is-refreshing');
      btn.setAttribute('aria-busy', 'true');
    } else {
      btn.classList.remove('is-refreshing');
      btn.removeAttribute('aria-busy');
    }
  },

  /**
   * Formatea una fecha ISO a texto legible amigable
   * @param {string} isoString
   * @param {boolean} isCache
   * @returns {string}
   */
  formatTimestamp(isoString, isCache = false) {
    if (!isoString) return 'Actualizado recientemente';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return 'Actualizado recientemente';

    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const timeStr = date.toLocaleTimeString('es-VE', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    const prefix = isCache ? 'Caché' : 'Actualizado';
    return isToday ? `${prefix}: hoy ${timeStr}` : `${prefix}: ${date.getDate()}/${date.getMonth() + 1} ${timeStr}`;
  }
};

// Exponer globalmente
window.ratesManager = ratesManager;

// Inicialización automática tras cargar el DOM
document.addEventListener('DOMContentLoaded', () => {
  ratesManager.init();
});
