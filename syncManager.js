/**
 * ============================================================================
 * GastosYa - Gestor de Sincronización y Respaldo Offline (Fase 4.3)
 * ============================================================================
 * Maneja la detección de conectividad en tiempo real (navigator.onLine), la cola
 * local de transacciones pendientes en localStorage ('gastosya_sync_queue'),
 * y el drenado automático hacia Supabase cuando se restablece la conexión o se inicia sesión.
 * ============================================================================
 */

'use strict';

const syncManager = {
  queueKey: 'gastosya_sync_queue',
  isSyncing: false,

  /**
   * Inicializa escuchadores de conectividad y ciclo de sesión
   */
  init() {
    this.updateOnlineStatus();

    // Permitir forzar sincronización manual tocando la píldora de estado
    const pill = document.getElementById('offline-pill');
    if (pill) {
      pill.style.cursor = 'pointer';
      pill.setAttribute('title', 'Toca para forzar sincronización con la nube');
      pill.addEventListener('click', () => {
        if (this.isOnline()) {
          console.log('🔄 [syncManager] Sincronización manual iniciada por el usuario.');
          this.syncPendingQueue();
        }
      });
    }

    // Eventos nativos del navegador de conectividad
    window.addEventListener('online', () => {
      console.log('🌐 [GastosYa] Conexión a internet restablecida.');
      this.updateOnlineStatus();
      this.syncPendingQueue();
    });

    window.addEventListener('offline', () => {
      console.warn('📡 [GastosYa] Conexión perdida. Activando modo offline.');
      this.updateOnlineStatus();
    });

    // Suscripción al evento de autenticación para sincronizar al iniciar sesión
    window.addEventListener('gastosya:auth-changed', (event) => {
      const { session, user } = event.detail || {};
      if (session && user) {
        if (this.isOnline()) {
          setTimeout(() => this.syncPendingQueue(), 500);
        }
      }
    });

    // Si al arrancar la app ya hay conexión y elementos en cola, intentar sincronizar
    if (this.isOnline() && this.getQueue().length > 0) {
      setTimeout(() => this.syncPendingQueue(), 800);
    }
  },

  /**
   * Indica si el navegador tiene conexión a la red
   * @returns {boolean}
   */
  isOnline() {
    return typeof navigator !== 'undefined' ? navigator.onLine : true;
  },

  /**
   * Obtiene la cola de transacciones pendientes desde localStorage
   * @returns {Array}
   */
  getQueue() {
    try {
      const data = localStorage.getItem(this.queueKey);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      console.error('❌ [syncManager] Error leyendo cola de sincronización:', e);
      return [];
    }
  },

  /**
   * Guarda la cola en localStorage y actualiza el indicador visual
   * @param {Array} queue
   */
  saveQueue(queue) {
    try {
      localStorage.setItem(this.queueKey, JSON.stringify(queue));
      this.updateOnlineStatus();
    } catch (e) {
      console.error('❌ [syncManager] Error guardando cola:', e);
    }
  },

  /**
   * Añade una transacción a la cola de sincronización offline
   * @param {object} tx
   */
  enqueue(tx) {
    const queue = this.getQueue();
    const existingIndex = queue.findIndex(item => item.id === tx.id);
    if (existingIndex >= 0) {
      queue[existingIndex] = tx;
    } else {
      queue.push(tx);
    }
    this.saveQueue(queue);
    console.log(`📦 [syncManager] Transacción encolada offline (${queue.length} en espera).`);

    // Si estamos online y el usuario está autenticado, intentar sincronizar de inmediato
    if (this.isOnline() && window.authManager?.currentUser) {
      setTimeout(() => this.syncPendingQueue(), 200);
    }
  },

  /**
   * Elimina una transacción específica de la cola
   * @param {string} id
   */
  dequeue(id) {
    const queue = this.getQueue().filter(item => item.id !== id);
    this.saveQueue(queue);
  },

  /**
   * Limpia toda la cola
   */
  clearQueue() {
    try {
      localStorage.removeItem(this.queueKey);
      this.updateOnlineStatus();
    } catch (e) { }
  },

  /**
   * Actualiza el badge visual de estado offline / sincronización en la UI
   */
  updateOnlineStatus() {
    const pill = document.getElementById('offline-pill');
    const textEl = document.getElementById('offline-text');
    if (!pill) return;

    const online = this.isOnline();
    const queue = this.getQueue();

    if (!online) {
      pill.style.display = 'inline-flex';
      pill.classList.remove('is-syncing');
      if (textEl) {
        textEl.textContent = queue.length > 0 ? `Offline (${queue.length} en cola)` : 'Modo Offline';
      }
    } else if (queue.length > 0) {
      pill.style.display = 'inline-flex';
      pill.classList.add('is-syncing');
      if (textEl) {
        textEl.textContent = `Sincronizando ${queue.length}...`;
      }
    } else {
      pill.style.display = 'none';
      pill.classList.remove('is-syncing');
    }
  },

  /**
   * Drena y envía la cola de transacciones pendientes hacia Supabase
   */
  async syncPendingQueue() {
    if (!this.isOnline()) {
      this.updateOnlineStatus();
      return;
    }

    if (this.isSyncing) return;

    const client = window.supabaseClient;
    const user = window.authManager?.currentUser;
    if (!client || !user) {
      this.updateOnlineStatus();
      return;
    }

    const queue = this.getQueue();
    if (queue.length === 0) {
      this.updateOnlineStatus();
      return;
    }

    this.isSyncing = true;
    this.updateOnlineStatus();
    console.log(`⚡ [syncManager] Drenando cola offline (${queue.length} gastos pendientes)...`);

    const syncedItems = [];

    for (const item of queue) {
      try {
        // Resolver y sanear category_id a UUID válido o null para evitar error 22P02 en PostgreSQL
        let catId = null;
        if (typeof window.resolveCategoryId === 'function') {
          catId = window.resolveCategoryId(item.category_id || item.category);
        } else if (typeof window.isValidUUID === 'function' && window.isValidUUID(item.category_id)) {
          catId = item.category_id;
        }

        const payload = {
          user_id: user.id,
          category_id: catId,
          amount_original: Number(item.amountOriginal),
          currency: item.currencyOriginal,
          rate_type: typeof window.mapRateTypeToDB === 'function'
            ? window.mapRateTypeToDB(item.rateType, item.currencyOriginal)
            : (item.rateType || 'NONE'),
          rate_value: Math.max(0.0001, Number(item.rateValue) || 1.0),
          amount_usd: Math.max(0.01, Number(item.amountUSD) || 0.01),
          note: item.note ? String(item.note).trim() : null,
          spent_at: item.timestamp || item.spent_at || new Date().toISOString()
        };

        let { data, error } = await client
          .from('transactions')
          .insert([payload])
          .select()
          .single();

        // Rescate defensivo: si falló por sintaxis UUID (22P02) o clave foránea (23503), reintentar con null
        if (error && (error.code === '22P02' || error.code === '23503' || (error.message && error.message.includes('uuid')))) {
          console.warn('[syncManager] Reintentando sincronización con category_id = null...');
          payload.category_id = null;
          const retryRes = await client
            .from('transactions')
            .insert([payload])
            .select()
            .single();
          data = retryRes.data;
          error = retryRes.error;
        }

        if (error) {
          console.error('[syncManager] Error al sincronizar transacción:', error.message, error);

          // Si el error es de conectividad, pausar y reintentar cuando vuelva la red
          if (error.message && (error.message.includes('fetch') || error.message.includes('network') || error.message.includes('Failed to fetch'))) {
            break;
          }

          // Si es un error irrecuperable de base de datos, contar reintentos
          item._errorCount = (item._errorCount || 0) + 1;
          if (item._errorCount >= 3) {
            console.error(`❌ [syncManager] Transacción ${item.id} descartada de la cola tras 3 rechazos: ${error.message}`);
            syncedItems.push({ tempId: item.id, discarded: true });
          }
        } else if (data) {
          syncedItems.push({ tempId: item.id, newId: data.id });
        }
      } catch (err) {
        console.warn('[syncManager] Excepción sincronizando item, pausando:', err);
        break;
      }
    }

    if (syncedItems.length > 0) {
      // 1. Remover ítems exitosos o descartados de la cola
      const remainingQueue = this.getQueue().filter(
        item => !syncedItems.some(s => s.tempId === item.id)
      );
      this.saveQueue(remainingQueue);

      // 2. Reemplazar IDs temporales en el estado de app.js y remover marca pending
      if (typeof window.state !== 'undefined' && Array.isArray(window.state.transactions)) {
        syncedItems.forEach(({ tempId, newId }) => {
          const tx = window.state.transactions.find(t => t.id === tempId);
          if (tx) {
            if (newId) tx.id = newId;
            tx._pendingSync = false;
          }
        });

        if (typeof window.saveTransactionsToStorage === 'function') {
          window.saveTransactionsToStorage();
        }
        if (typeof window.render !== 'undefined' && typeof window.render.transactionsFeed === 'function') {
          window.render.transactionsFeed();
        }
        if (typeof window.analyticsManager !== 'undefined' && typeof window.analyticsManager.render === 'function') {
          window.analyticsManager.render();
        }
      }

      console.log(`✅ [syncManager] ${syncedItems.length} transacciones procesadas con éxito desde la cola.`);
    }

    this.isSyncing = false;
    this.updateOnlineStatus();
  }
};

// Exponer globalmente
window.syncManager = syncManager;

// Inicialización automática al cargar el DOM
document.addEventListener('DOMContentLoaded', () => {
  syncManager.init();
});
