/**
 * ============================================================================
 * GastosYa - Registro Rápido Multimoneda
 * Capa de Comportamiento, Reactividad y Persistencia en Vanilla JavaScript
 * ============================================================================
 */

'use strict';

// Aplicación síncrona inmediata antes del ciclo DOM para eliminar parpadeo (FOUC)
(function applyImmediateTheme() {
  try {
    const saved = localStorage.getItem('gastosya_theme');
    if (saved) {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch (e) {}
})();

// ============================================================================
// 1. ESTADO GLOBAL (State)
// ============================================================================
const state = {
  // Tasas de cambio vigentes del mercado
  rates: {
    BCV: 45.20,      // VES por 1 USD
    BCV_EUR: 49.30,  // VES por 1 EUR
    PARALELO: 52.10, // VES por 1 USD
    EUR_USD: 1.09    // Factor cruzado estándar (49.30 / 45.20 ≈ 1.09)
  },

  // Selecciones activas en el formulario
  currentCurrency: 'VES',
  currentRateType: 'BCV',
  selectedRateType: 'BCV',
  currentRateValue: 45.20,

  // Vista y filtros de navegación
  currentView: 'view-register',
  activeCategoryFilter: 'all',

  // Colección de transacciones
  transactions: [],

  // Colección dinámica y selección activa de categorías
  categories: [],
  selectedCategory: 'comida'
};

// Claves de almacenamiento persistente en localStorage
const STORAGE_KEY = 'gastosya_transactions';
const CATEGORIES_STORAGE_KEY = 'gastosya_categories';

// Categorías iniciales por defecto (Requerimiento Paso 3)
const DEFAULT_CATEGORIES = [
  { id: 'comida',     label: 'Comida',     icon: '🍔', isDefault: true },
  { id: 'mercado',    label: 'Mercado',    icon: '🛒', isDefault: true },
  { id: 'transporte', label: 'Transporte', icon: '🚗', isDefault: true },
  { id: 'servicios',  label: 'Servicios',  icon: '💡', isDefault: true },
  { id: 'farmacia',   label: 'Farmacia',   icon: '💊', isDefault: true },
  { id: 'otros',      label: 'Otros',      icon: '📦', isDefault: true }
];

// Mapeo visual y semántico de categorías (sincronizado dinámicamente)
let CATEGORIES = {};

// ============================================================================
// CONVERSORES Y MAPEOS ENTRE FRONTEND Y SUPABASE (Data Mappers)
// ============================================================================

/**
 * Mapea la tasa seleccionada a los valores válidos del enum en Postgres
 * CHECK (rate_type IN ('BCV', 'PARALELO', 'MANUAL', 'NONE'))
 */
function mapRateTypeToDB(rateType, currency) {
  if (currency === 'USD' || currency === 'USDT') return 'NONE';
  if (currency === 'EUR') return 'MANUAL';
  if (rateType === 'BCV') return 'BCV';
  if (rateType === 'PARALELO') return 'PARALELO';
  return 'MANUAL';
}
window.mapRateTypeToDB = mapRateTypeToDB;

/**
 * Convierte un registro de la tabla Supabase 'transactions' al modelo frontend
 */
function dbToFrontendTx(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    category_id: row.category_id,
    category: row.category_id,
    amountOriginal: Number(row.amount_original),
    currencyOriginal: row.currency,
    rateType: row.rate_type,
    rateValue: Number(row.rate_value),
    amountUSD: Number(row.amount_usd),
    note: row.note || '',
    timestamp: row.spent_at,
    spent_at: row.spent_at,
    created_at: row.created_at,
    _pendingSync: !!row._pendingSync
  };
}

/**
 * Convierte un objeto de gasto frontend al formato DDL de Supabase
 */
function frontendToDbTx(tx, userId) {
  return {
    id: tx.id,
    user_id: userId,
    category_id: tx.category_id || tx.category || null,
    amount_original: Number(tx.amountOriginal),
    currency: tx.currencyOriginal,
    rate_type: mapRateTypeToDB(tx.rateType, tx.currencyOriginal),
    rate_value: Number(tx.rateValue) || 1.0,
    amount_usd: Number(tx.amountUSD),
    note: tx.note ? tx.note.trim() : null,
    spent_at: tx.timestamp || tx.spent_at || new Date().toISOString()
  };
}

// ============================================================================
// 2. LÓGICA DE CÁLCULO Y NORMALIZACIÓN (Calculator)
// ============================================================================
const calculator = {
  /**
   * Sanitiza y convierte texto a número decimal
   * Soporta coma o punto como separador
   */
  parseNumber(value) {
    if (typeof value === 'number') return isNaN(value) ? 0 : value;
    if (!value) return 0;
    const cleanStr = String(value).trim().replace(',', '.');
    const parsed = parseFloat(cleanStr);
    return isNaN(parsed) ? 0 : parsed;
  },

  /**
   * Normaliza cualquier transacción a USD con precisión de 2 decimales
   * Implementación canónica documentada en docs/data-model.md
   */
  normalizeToUSD(amountOriginal, currencyOriginal, rateValue) {
    const amount = this.parseNumber(amountOriginal);
    if (amount <= 0) return 0;

    // 1:1 para USD y USDT
    if (currencyOriginal === 'USD' || currencyOriginal === 'USDT') {
      return Math.round(amount * 100) / 100;
    }

    // Normalización desde Bolívares
    if (currencyOriginal === 'VES') {
      const rate = this.parseNumber(rateValue);
      if (rate <= 0) return 0;
      return Math.round((amount / rate) * 100) / 100;
    }

    // Normalización desde Euros (Conversión cruzada EUR -> USD)
    if (currencyOriginal === 'EUR') {
      const crossRate = this.parseNumber(rateValue) > 0 
        ? this.parseNumber(rateValue) 
        : state.rates.EUR_USD;
      return Math.round(amount * crossRate * 100) / 100;
    }

    return amount;
  },

  /**
   * Calcula la equivalencia dinámica cruzada para la interfaz de registro
   * - Si currency es 'VES': muestra la equivalencia normalizada en USD ("≈ $X.XX USD"),
   *   dividiendo entre la tasa activa.
   * - Si currency es 'USD', 'EUR' o 'USDT': muestra la equivalencia calculada en Bolívares
   *   ("≈ Bs. X.XX"), multiplicando por la tasa de cambio activa o tasa cruzada.
   *
   * @param {number|string} amountOriginal - Monto ingresado
   * @param {string} currencyOriginal - 'VES' | 'USD' | 'EUR' | 'USDT'
   * @param {object} [options] - Opciones contextuales ({ rateType, rateValue, rates })
   * @returns {{ text: string, value: number, targetCurrency: string }}
   */
  calculateEquivalence(amountOriginal, currencyOriginal, options = {}) {
    const amount = this.parseNumber(amountOriginal);
    const rates = options.rates || (typeof state !== 'undefined' ? state.rates : {
      BCV: 45.20,
      BCV_EUR: 49.30,
      PARALELO: 52.10,
      EUR_USD: 1.09
    });

    const rateType = options.rateType || (typeof state !== 'undefined' ? (state.selectedRateType || state.currentRateType) : 'BCV');
    const customRateVal = this.parseNumber(options.rateValue);

    // 1. Moneda de pago: VES -> Mostrar equivalencia en USD
    if (currencyOriginal === 'VES') {
      if (amount <= 0) {
        return { text: '≈ $0.00 USD', value: 0, targetCurrency: 'USD' };
      }

      let activeRate = customRateVal > 0 ? customRateVal : rates.BCV;
      if (rateType === 'PARALELO' && (!customRateVal || customRateVal <= 0)) {
        activeRate = rates.PARALELO;
      } else if (rateType === 'BCV_EUR' && (!customRateVal || customRateVal <= 0)) {
        activeRate = rates.BCV_EUR;
      } else if (rateType === 'BCV' && (!customRateVal || customRateVal <= 0)) {
        activeRate = rates.BCV;
      }

      const usdVal = activeRate > 0 ? Math.round((amount / activeRate) * 100) / 100 : 0;
      return {
        text: `≈ $${usdVal.toFixed(2)} USD`,
        value: usdVal,
        targetCurrency: 'USD'
      };
    }

    // 2. Moneda de pago: USD, EUR o USDT -> Mostrar equivalencia en Bolívares (Bs.)
    if (amount <= 0) {
      return { text: '≈ Bs. 0.00', value: 0, targetCurrency: 'VES' };
    }

    let vesRate = rates.BCV;

    if (currencyOriginal === 'USDT') {
      // 1. USDT: Vinculado directamente a la tasa Paralelo (Binance P2P / Mercado libre)
      vesRate = rates.PARALELO || 52.10;
    } else if (currencyOriginal === 'USD') {
      // 2. USD: Vinculado directamente a la tasa oficial del BCV
      vesRate = rates.BCV || 45.20;
    } else if (currencyOriginal === 'EUR') {
      // 3. EUR: Vinculado directamente a la tasa oficial del Euro (BCV EUR)
      vesRate = rates.BCV_EUR || (rates.BCV * (rates.EUR_USD || 1.09)) || 49.30;
    } else {
      vesRate = 1.0;
    }

    const vesVal = Math.round(amount * vesRate * 100) / 100;
    return {
      text: `≈ Bs. ${vesVal.toFixed(2)}`,
      value: vesVal,
      targetCurrency: 'VES'
    };
  },

  /**
   * Formatea un número como divisa visual estándar
   */
  formatCurrency(value, currency = 'USD') {
    const num = this.parseNumber(value);
    const formatted = num.toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });

    switch (currency) {
      case 'VES': return `${formatted} Bs.`;
      case 'USD': return `$${formatted}`;
      case 'EUR': return `€${formatted}`;
      case 'USDT': return `${formatted} USDT`;
      default: return `${formatted} ${currency}`;
    }
  },

  /**
   * Genera una cadena legible de fecha relativa
   */
  formatRelativeDate(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '';

    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday = date.toDateString() === yesterday.toDateString();

    const timeStr = date.toLocaleTimeString('es-VE', { 
      hour: 'numeric', 
      minute: '2-digit', 
      hour12: true 
    });

    if (isToday) return `Hoy, ${timeStr}`;
    if (isYesterday) return `Ayer, ${timeStr}`;

    const dateStr = date.toLocaleDateString('es-VE', { 
      day: 'numeric', 
      month: 'short' 
    });
    return `${dateStr}, ${timeStr}`;
  }
};

// ============================================================================
// 3. RENDERIZADO Y ACTUALIZACIÓN DEL DOM (Render)
// ============================================================================
const render = {
  // Referencias a elementos clave del DOM
  elements: {
    form: document.getElementById('expense-form'),
    amountInput: document.getElementById('amount-input'),
    currencySymbol: document.getElementById('display-currency-symbol'),
    previewUSD: document.getElementById('equivalent-amount') || document.getElementById('preview-usd-value'),
    rateConfigCard: document.getElementById('rate-config-card'),
    rateValueInput: document.getElementById('rate-value-input'),
    rateInputLabel: document.querySelector('.rate-input-label'),
    rateInputPrefix: document.querySelector('.rate-input-prefix'),
    noteInput: document.getElementById('expense-note'),
    submitBtn: document.getElementById('btn-submit-expense'),
    movementsList: document.getElementById('movements-list'),
    movementsCounter: document.getElementById('movements-counter')
  },

  /**
   * Actualiza la píldora de equivalencia dinámica cruzada
   * (VES -> USD, o USD/EUR/USDT -> Bolívares)
   */
  livePreview() {
    const rawAmount = this.elements.amountInput ? this.elements.amountInput.value : '';
    const amount = calculator.parseNumber(rawAmount);

    let activeRateType = state.currentRateType;
    let rateVal = state.currentRateValue;

    if (state.currentCurrency === 'USDT') {
      activeRateType = 'PARALELO';
      rateVal = state.rates.PARALELO;
    } else if (state.currentCurrency === 'USD') {
      activeRateType = 'BCV';
      rateVal = state.rates.BCV;
    } else if (state.currentCurrency === 'EUR') {
      activeRateType = 'BCV_EUR';
      rateVal = state.rates.BCV_EUR || (state.rates.BCV * (state.rates.EUR_USD || 1.09));
    } else if (state.currentCurrency === 'VES') {
      const activeRateRadio = document.querySelector('input[name="rateType"]:checked');
      activeRateType = activeRateRadio ? activeRateRadio.value : (state.selectedRateType || 'BCV');

      if (activeRateType === 'CUSTOM' && this.elements.rateValueInput) {
        rateVal = calculator.parseNumber(this.elements.rateValueInput.value);
      } else if (activeRateType === 'PARALELO') {
        rateVal = state.rates.PARALELO;
      } else if (activeRateType === 'BCV_EUR') {
        rateVal = state.rates.BCV_EUR;
      } else {
        rateVal = state.rates.BCV;
      }
    }

    const eq = calculator.calculateEquivalence(
      amount,
      state.currentCurrency,
      {
        rateType: activeRateType,
        rateValue: rateVal,
        rates: state.rates
      }
    );

    const previewEl = this.elements.previewUSD || 
      document.getElementById('equivalent-amount') || 
      document.getElementById('preview-usd-value');

    if (previewEl) {
      previewEl.textContent = eq.text;
    }
  },

  /**
   * Sincroniza la visibilidad de la tarjeta de tasas.
   * La tasa en Bs solo debe ser visible cuando la moneda es VES.
   */
  rateSectionVisibility() {
    const isVES = state.currentCurrency === 'VES';

    if (isVES) {
      this.elements.rateConfigCard.classList.remove('is-hidden');
      if (this.elements.rateInputLabel) {
        this.elements.rateInputLabel.textContent = 'Tasa de cambio (VES):';
      }
      if (this.elements.rateInputPrefix) {
        this.elements.rateInputPrefix.textContent = 'Bs.';
      }
    } else {
      // Ocultar para USD, USDT y EUR (divisas directas)
      this.elements.rateConfigCard.classList.add('is-hidden');
    }
  },

  /**
   * Actualiza el símbolo monetario al lado del input principal
   */
  currencySymbol() {
    switch (state.currentCurrency) {
      case 'VES': this.elements.currencySymbol.textContent = 'Bs.'; break;
      case 'USD': this.elements.currencySymbol.textContent = '$'; break;
      case 'EUR': this.elements.currencySymbol.textContent = '€'; break;
      case 'USDT': this.elements.currencySymbol.textContent = '₮'; break;
    }
  },

  /**
   * Sincroniza el valor numérico del input de tasa según la selección activa
   */
  rateValueInput() {
    if (state.currentRateType !== 'CUSTOM') {
      let targetRate = state.rates.BCV;

      if (state.currentCurrency === 'USDT') {
        targetRate = state.rates.PARALELO;
      } else if (state.currentCurrency === 'USD') {
        targetRate = state.rates.BCV;
      } else if (state.currentCurrency === 'EUR') {
        targetRate = state.rates.BCV_EUR || (state.rates.BCV * (state.rates.EUR_USD || 1.09));
      } else { // VES
        if (state.currentRateType === 'BCV') targetRate = state.rates.BCV;
        else if (state.currentRateType === 'BCV_EUR') targetRate = state.rates.BCV_EUR;
        else if (state.currentRateType === 'PARALELO') targetRate = state.rates.PARALELO;
      }

      state.currentRateValue = targetRate;
      if (this.elements.rateValueInput) {
        this.elements.rateValueInput.value = targetRate.toFixed(2);
      }
    }
  },

  /**
   * Genera el HTML de una tarjeta de transacción individual
   */
  createTransactionItemHTML(tx) {
    const catId = tx.category_id || tx.category;
    const catData = CATEGORIES[catId] || CATEGORIES.otros || {
      label: 'Sin categoría',
      icon: '📦',
      badgeClass: 'cat-otros'
    };

    // Etiqueta de la tasa aplicada
    let rateBadgeText = 'Directo USD';
    let rateBadgeClass = 'direct';

    if (tx.currencyOriginal === 'VES') {
      if (tx.rateType === 'BCV') {
        rateBadgeText = `BCV @ ${Number(tx.rateValue).toFixed(2)} Bs.`;
        rateBadgeClass = '';
      } else if (tx.rateType === 'BCV_EUR') {
        rateBadgeText = `BCV € @ ${Number(tx.rateValue).toFixed(2)} Bs.`;
        rateBadgeClass = 'eur';
      } else if (tx.rateType === 'PARALELO') {
        rateBadgeText = `Paralelo @ ${Number(tx.rateValue).toFixed(2)} Bs.`;
        rateBadgeClass = 'paralelo';
      } else {
        rateBadgeText = `Manual @ ${Number(tx.rateValue).toFixed(2)} Bs.`;
        rateBadgeClass = '';
      }
    } else if (tx.currencyOriginal === 'EUR') {
      rateBadgeText = `Paridad EUR ($${(Number(tx.rateValue) || 1.09).toFixed(2)})`;
      rateBadgeClass = 'eur';
    } else if (tx.currencyOriginal === 'USDT') {
      rateBadgeText = 'USDT 1:1';
      rateBadgeClass = 'direct';
    }

    const origFormatted = calculator.formatCurrency(tx.amountOriginal, tx.currencyOriginal);
    const usdFormatted = `$${Number(tx.amountUSD).toFixed(2)}`;
    const relativeDate = calculator.formatRelativeDate(tx.timestamp || tx.spent_at);
    const noteText = tx.note || 'Sin nota';

    return `
      <article class="transaction-item animate-in ${tx._pendingSync ? 'is-pending-sync' : ''}" data-id="${tx.id}">
        <div class="trans-icon-badge ${catData.badgeClass || ''}" aria-hidden="true">${catData.icon || '🏷️'}</div>
        <div class="trans-content">
          <div class="trans-top-row">
            <span class="trans-category-tag">${escapeHtml(catData.label)}</span>
            ${tx._pendingSync ? `
              <span class="trans-pending-sync-badge" title="Guardado sin conexión. Se sincronizará automáticamente.">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>
                </svg>
                <span>En cola</span>
              </span>
            ` : ''}
            <time class="trans-timestamp" datetime="${tx.timestamp || tx.spent_at}">${relativeDate}</time>
          </div>
          <p class="trans-note" title="${escapeHtml(noteText)}">${escapeHtml(noteText)}</p>
          <div class="trans-meta-row">
            <span class="trans-rate-badge ${rateBadgeClass}">${rateBadgeText}</span>
          </div>
        </div>
        <div class="trans-amounts">
          <strong class="trans-amount-usd">${usdFormatted}</strong>
          <span class="trans-amount-orig">${origFormatted}</span>
        </div>
        <button type="button" class="btn-delete-trans" data-action="delete" data-id="${tx.id}" aria-label="Eliminar gasto">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </article>
    `;
  },

  /**
   * Renderiza la lista completa de movimientos y el contador respetando filtros
   */
  transactionsFeed() {
    const list = this.elements.movementsList;
    const counter = this.elements.movementsCounter;

    if (!list) return;

    const filter = state.activeCategoryFilter || 'all';
    const filtered = filter === 'all'
      ? state.transactions
      : state.transactions.filter(tx => (tx.category_id === filter || tx.category === filter));

    const total = filtered.length;
    if (counter) {
      counter.textContent = total === 1 ? '1 registro' : `${total} registros`;
    }

    if (total === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">🧾</span>
          <p class="empty-title">No hay gastos para mostrar</p>
          <p class="empty-subtitle">${filter === 'all' ? 'Ingresa un monto en la pestaña Registrar para comenzar' : 'No se encontraron gastos en esta categoría'}</p>
        </div>
      `;
      return;
    }

    list.innerHTML = filtered
      .map(tx => this.createTransactionItemHTML(tx))
      .join('');
  },

  /**
   * Inserta una nueva transacción al inicio del feed sin redibujar todo el DOM
   */
  prependTransaction(tx) {
    const list = this.elements.movementsList;
    if (!list) return;

    // Si había un estado vacío, limpiarlo
    const emptyState = list.querySelector('.empty-state');
    if (emptyState) {
      list.innerHTML = '';
    }

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = this.createTransactionItemHTML(tx).trim();
    const newElement = tempDiv.firstElementChild;

    list.insertBefore(newElement, list.firstChild);

    // Actualizar contador
    const total = state.transactions.length;
    if (this.elements.movementsCounter) {
      this.elements.movementsCounter.textContent = total === 1 ? '1 registro' : `${total} registros`;
    }
  }
};

// ============================================================================
// 4. MANEJADORES DE EVENTOS (Handlers)
// ============================================================================
const handlers = {
  /**
   * Entrada de texto en el input principal de monto
   */
  onAmountInput(event) {
    render.elements.amountInput.classList.remove('input-error');
    render.livePreview();
  },

  /**
   * Cambio de divisa de pago (VES, USD, EUR, USDT)
   */
  onCurrencyChange(event) {
    if (event.target.name !== 'currencyOriginal') return;

    state.currentCurrency = event.target.value;
    render.currencySymbol();
    render.rateSectionVisibility();

    // Sincronizar tasa aplicable según divisa seleccionada
    if (state.currentCurrency === 'USDT') {
      state.currentRateType = 'PARALELO';
      state.currentRateValue = state.rates.PARALELO;
    } else if (state.currentCurrency === 'USD') {
      state.currentRateType = 'BCV';
      state.currentRateValue = state.rates.BCV;
    } else if (state.currentCurrency === 'EUR') {
      state.currentRateType = 'BCV_EUR';
      state.currentRateValue = state.rates.BCV_EUR || (state.rates.BCV * (state.rates.EUR_USD || 1.09));
    } else if (state.currentCurrency === 'VES') {
      const activeRateRadio = document.querySelector('input[name="rateType"]:checked');
      state.currentRateType = activeRateRadio ? activeRateRadio.value : (state.selectedRateType || 'BCV');
      render.rateValueInput();
    }

    render.livePreview();
  },

  /**
   * Cambio de tipo de tasa (BCV, BCV_EUR, PARALELO, CUSTOM)
   */
  onRateTypeChange(event) {
    if (event.target.name !== 'rateType') return;

    state.currentRateType = event.target.value;
    state.selectedRateType = event.target.value;
    render.rateValueInput();
    render.livePreview();

    // Si eligió Manual, hacer foco inmediato en el campo de tasa
    if (state.currentRateType === 'CUSTOM') {
      render.elements.rateValueInput.focus();
      render.elements.rateValueInput.select();
    }
  },

  /**
   * Modificación manual del valor numérico de la tasa
   */
  onRateValueInput(event) {
    const val = calculator.parseNumber(event.target.value);
    state.currentRateValue = val;

    // Cambiar automáticamente la selección a Manual si no lo estaba
    const customRadio = document.getElementById('rate-custom');
    if (customRadio && !customRadio.checked) {
      customRadio.checked = true;
      state.currentRateType = 'CUSTOM';
    }
    state.selectedRateType = 'CUSTOM';

    render.livePreview();
  },

  /**
   * Envío del formulario de registro de gasto
   */
  async onFormSubmit(event) {
    event.preventDefault();

    const amountInput = render.elements.amountInput;
    const amountVal = calculator.parseNumber(amountInput.value);

    // Validación: Monto > 0
    if (amountVal <= 0) {
      amountInput.classList.add('input-error');
      amountInput.focus();
      return;
    }

    const user = window.authManager?.currentUser;
    if (!user) {
      alert('Debes iniciar sesión para registrar un gasto.');
      return;
    }

    // Categoría seleccionada
    let categoryId = state.selectedCategory;
    const selectedCat = (state.categories || []).find(c => c.id === categoryId);
    if (!selectedCat && state.categories.length > 0) {
      categoryId = state.categories[0].id;
    }

    // Determinar valores de tasa según divisa
    let rateType = 'DIRECT';
    let rateValue = 1.0;

    if (state.currentCurrency === 'USD' || state.currentCurrency === 'USDT') {
      rateType = 'DIRECT';
      rateValue = 1.0;
    } else if (state.currentCurrency === 'EUR') {
      rateType = 'PARIDAD_EUR';
      rateValue = state.rates.EUR_USD || 1.09;
    } else { // VES
      rateType = state.currentRateType;
      rateValue = calculator.parseNumber(render.elements.rateValueInput.value);
      if (rateValue <= 0) {
        render.elements.rateValueInput.focus();
        return;
      }
    }

    // Calcular monto normalizado a USD
    const amountUSD = calculator.normalizeToUSD(amountVal, state.currentCurrency, rateValue);
    const noteVal = render.elements.noteInput.value.trim();
    const nowIso = new Date().toISOString();
    const dbRateType = mapRateTypeToDB(rateType, state.currentCurrency);

    // Objeto frontend con ID temporal inicial
    const localId = generateUUID();
    const newTx = {
      id: localId,
      user_id: user.id,
      category_id: categoryId,
      category: categoryId,
      amountOriginal: amountVal,
      currencyOriginal: state.currentCurrency,
      rateType: rateType,
      rateValue: rateValue,
      amountUSD: amountUSD,
      note: noteVal,
      timestamp: nowIso,
      spent_at: nowIso,
      _pendingSync: false
    };

    const client = window.supabaseClient;
    const isOnline = window.syncManager ? window.syncManager.isOnline() : navigator.onLine;

    let savedRemotely = false;

    // Intentar inserción directa en Supabase si hay conexión
    if (isOnline && client) {
      try {
        const dbPayload = {
          user_id: user.id,
          category_id: categoryId,
          amount_original: amountVal,
          currency: state.currentCurrency,
          rate_type: dbRateType,
          rate_value: rateValue,
          amount_usd: amountUSD,
          note: noteVal || null,
          spent_at: nowIso
        };

        const { data, error } = await client
          .from('transactions')
          .insert([dbPayload])
          .select()
          .single();

        if (error) {
          console.warn('⚠️ [GastosYa] Error al insertar en Supabase, enviando a cola offline:', error.message);
        } else if (data) {
          newTx.id = data.id; // Asignar UUID definitivo generado por PostgreSQL
          savedRemotely = true;
        }
      } catch (err) {
        console.warn('⚠️ [GastosYa] Falla de red al conectar con Supabase, encolando offline:', err);
      }
    }

    // Si falló la red o no hay conexión, encolar como pendiente
    if (!savedRemotely) {
      newTx._pendingSync = true;
      if (window.syncManager) {
        window.syncManager.enqueue(newTx);
      }
    }

    // Actualizar estado y almacenamiento local
    state.transactions.unshift(newTx);
    saveTransactionsToStorage();

    // Renderizar tarjeta al inicio del feed
    render.prependTransaction(newTx);

    // Limpiar input de monto y nota
    amountInput.value = '';
    render.elements.noteInput.value = '';
    render.livePreview();

    // Feedback visual breve en botón
    const submitBtn = render.elements.submitBtn;
    if (submitBtn) {
      const origText = submitBtn.innerHTML;
      submitBtn.innerHTML = savedRemotely 
        ? `<span>✓ ¡Registrado!</span>` 
        : `<span>☁️ Guardado (Offline)</span>`;
      setTimeout(() => {
        submitBtn.innerHTML = origText;
      }, 1200);
    }

    // Actualizar métricas del resumen
    analyticsManager.render();
  },

  /**
   * Eliminación de transacción desde el botón de la tarjeta
   */
  async onMovementsListClick(event) {
    const deleteBtn = event.target.closest('[data-action="delete"]');
    if (!deleteBtn) return;

    const txId = deleteBtn.getAttribute('data-id');
    if (!txId) return;

    const targetTx = state.transactions.find(t => t.id === txId);

    // Si estaba en la cola de sincronización pendiente, eliminarlo de la cola
    if (window.syncManager) {
      window.syncManager.dequeue(txId);
    }

    // Si está conectado y el registro estaba en Supabase (no era pending)
    const client = window.supabaseClient;
    const isOnline = window.syncManager ? window.syncManager.isOnline() : navigator.onLine;

    if (client && isOnline && targetTx && !targetTx._pendingSync) {
      try {
        const { error } = await client.from('transactions').delete().eq('id', txId);
        if (error) {
          console.warn('⚠️ Error eliminando en Supabase:', error.message);
        }
      } catch (err) {
        console.warn('⚠️ Excepción eliminando en Supabase:', err);
      }
    }

    // Filtrar del estado local
    state.transactions = state.transactions.filter(t => t.id !== txId);
    saveTransactionsToStorage();

    // Eliminar del DOM con transición suave
    const card = deleteBtn.closest('.transaction-item');
    if (card) {
      card.style.opacity = '0';
      card.style.transform = 'scale(0.95)';
      setTimeout(() => {
        render.transactionsFeed();
        analyticsManager.render();
      }, 180);
    }
  },

  /**
   * Manejador de clics en los filtros de categoría del historial
   */
  onFilterClick(event) {
    const chip = event.target.closest('[data-filter]');
    if (!chip) return;

    const category = chip.getAttribute('data-filter');
    state.activeCategoryFilter = category;

    // Actualizar estilos activos de los chips
    const chips = document.querySelectorAll('.filter-chip');
    chips.forEach(c => {
      c.classList.toggle('is-active', c.getAttribute('data-filter') === category);
    });

    render.transactionsFeed();
  }
};

// ============================================================================
// 5. PERSISTENCIA Y UTILIDADES
// ============================================================================

/**
 * Guarda las transacciones en localStorage
 */
function saveTransactionsToStorage() {
  try {
    const user = window.authManager?.currentUser;
    const storageKey = user ? `gastosya_tx_${user.id}` : STORAGE_KEY;
    localStorage.setItem(storageKey, JSON.stringify(state.transactions));
  } catch (err) {
    console.error('Error guardando en localStorage:', err);
  }
}

/**
 * Carga transacciones desde el almacenamiento local o inicia vacío
 */
function loadTransactionsFromStorage() {
  const user = window.authManager?.currentUser;
  const storageKey = user ? `gastosya_tx_${user.id}` : STORAGE_KEY;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        state.transactions = parsed;
        return;
      }
    }
  } catch (err) {
    console.warn('Error leyendo localStorage:', err);
  }

  // Historial inicia vacío para nuevos usuarios (sin mock data hardcodeado)
  state.transactions = [];
}

/**
 * Consulta las transacciones del usuario en Supabase y las combina con la cola offline
 * @param {string} userId
 */
async function loadTransactionsFromSupabase(userId) {
  const client = window.supabaseClient;
  if (!client || !userId) {
    state.transactions = [];
    render.transactionsFeed();
    analyticsManager.render();
    return;
  }

  // Cargar caché local inmediato de este usuario si existe
  const userStorageKey = `gastosya_tx_${userId}`;
  try {
    const cached = localStorage.getItem(userStorageKey);
    if (cached) {
      state.transactions = JSON.parse(cached);
      render.transactionsFeed();
      analyticsManager.render();
    }
  } catch (e) {}

  // Consultar Supabase ordenado por fecha de gasto descendente
  try {
    const { data, error } = await client
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .order('spent_at', { ascending: false });

    if (error) {
      console.warn('⚠️ [GastosYa] Error al consultar transacciones de Supabase:', error.message);
      return;
    }

    if (Array.isArray(data)) {
      const serverTxs = data.map(dbToFrontendTx);

      // Obtener transacciones en cola local para no sobreescribir pendientes
      const pendingQueue = window.syncManager ? window.syncManager.getQueue() : [];
      const pendingTxs = pendingQueue.map(item => ({ ...item, _pendingSync: true }));

      const pendingIds = new Set(pendingTxs.map(p => p.id));
      const filteredServer = serverTxs.filter(s => !pendingIds.has(s.id));

      state.transactions = [...pendingTxs, ...filteredServer];

      saveTransactionsToStorage();
      render.transactionsFeed();
      analyticsManager.render();
    }
  } catch (err) {
    console.warn('⚠️ [GastosYa] Excepción al obtener transacciones de Supabase:', err);
  }
}

window.saveTransactionsToStorage = saveTransactionsToStorage;
window.loadTransactionsFromStorage = loadTransactionsFromStorage;
window.loadTransactionsFromSupabase = loadTransactionsFromSupabase;

/**
 * Genera un UUID v4 seguro o fallback compatible
 */
function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Escapa cadenas HTML para prevenir inyección XSS en notas
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================================
// 6. CONTROLADOR DE NAVEGACIÓN Y VISTAS (Navigation)
// ============================================================================
const navigation = {
  /**
   * Inicializa la navegación por vistas y delegación de clics
   */
  init() {
    // Delegación de eventos para botones con data-view (bottom-nav y desktop-nav)
    document.addEventListener('click', (event) => {
      const navBtn = event.target.closest('[data-view]');
      if (!navBtn) return;

      const targetView = navBtn.getAttribute('data-view');
      if (targetView) {
        this.switchView(targetView);
      }
    });

  },

  /**
   * Conmuta la vista activa y actualiza los botones de navegación
   * @param {string} viewId - Identificador de la sección (ej. 'view-register', 'view-history', 'view-analytics')
   */
  switchView(viewId) {
    const targetSection = document.getElementById(viewId);
    if (!targetSection) return;

    state.currentView = viewId;

    // Alternar visibilidad de las secciones (.app-view)
    const views = document.querySelectorAll('.app-view');
    views.forEach(view => {
      const isActive = view.id === viewId;
      view.classList.toggle('is-active', isActive);
      if (isActive) {
        view.removeAttribute('hidden');
      } else {
        view.setAttribute('hidden', '');
      }
    });

    // Sincronizar botones de navegación (tanto móvil como desktop)
    const navButtons = document.querySelectorAll('[data-view]');
    navButtons.forEach(btn => {
      const isSelected = btn.getAttribute('data-view') === viewId;
      btn.classList.toggle('is-active', isSelected);
      btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });

    // Refrescar contenidos específicos según la vista
    if (viewId === 'view-history') {
      render.transactionsFeed();
    } else if (viewId === 'view-analytics') {
      analyticsManager.render();
    }

    // Scroll suave al inicio
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
};

// ============================================================================
// 7. MÓDULO DE RESUMEN FINANCIERO Y ANALYTICS (analyticsManager)
// ============================================================================
const analyticsManager = {
  activePeriod: 'month', // 'week' | 'month' | 'all'

  // Paleta armónica distintiva para segmentos del gráfico donut y barras
  colors: {
    comida:     '#f59e0b',
    mercado:    '#38bdf8',
    transporte: '#3b82f6',
    servicios:  '#eab308',
    farmacia:   '#ef4444',
    otros:      '#a855f7'
  },

  palette: [
    '#10b981', '#38bdf8', '#f59e0b', '#f472b6', '#a855f7',
    '#ef4444', '#3b82f6', '#14b8a6', '#ec4899', '#84cc16'
  ],

  elements: {
    chartContainer: null,
    barsList: null,
    periodBadge: null,
    totalEl: null,
    avgEl: null,
    countEl: null,
    topCatEl: null,
    topPctEl: null
  },

  /**
   * Obtiene el color correspondiente para una categoría (predeterminado o dinámico)
   */
  getColor(catId, index = 0) {
    if (this.colors[catId]) {
      return this.colors[catId];
    }
    return this.palette[index % this.palette.length];
  },

  /**
   * Inicializa el módulo de analytics:
   * - Cachea los elementos del DOM.
   * - Enlaza la delegación de clics en la barra de períodos.
   * - Ejecuta el primer renderizado.
   */
  init() {
    this.elements.chartContainer = document.getElementById('analytics-chart-container');
    this.elements.barsList = document.getElementById('analytics-categories-bars');
    this.elements.periodBadge = document.getElementById('chart-period-badge');
    this.elements.totalEl = document.getElementById('kpi-total-usd');
    this.elements.avgEl = document.getElementById('kpi-avg-usd');
    this.elements.countEl = document.getElementById('kpi-count-trans');
    this.elements.topCatEl = document.getElementById('kpi-top-cat');
    this.elements.topPctEl = document.getElementById('kpi-top-pct');

    const toolbar = document.querySelector('.period-filter-toolbar');
    if (toolbar) {
      toolbar.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-period]');
        if (!chip) return;
        const period = chip.getAttribute('data-period');
        if (period) {
          this.setPeriod(period);
        }
      });
    }

    this.render();
  },

  /**
   * Establece el período activo y actualiza la vista
   * @param {'week'|'month'|'all'} period
   */
  setPeriod(period) {
    if (!['week', 'month', 'all'].includes(period)) return;
    this.activePeriod = period;

    // Actualizar clase activa en los botones chip
    document.querySelectorAll('.period-chip').forEach(btn => {
      btn.classList.toggle('is-active', btn.getAttribute('data-period') === period);
    });

    // Actualizar insignia de período en el header de analytics
    if (this.elements.periodBadge) {
      const labels = {
        week: 'Esta Semana',
        month: 'Este Mes',
        all: 'Todo el Historial'
      };
      this.elements.periodBadge.textContent = labels[period] || 'Este Mes';
    }

    this.render();
  },

  /**
   * Retorna las transacciones filtradas según la ventana de tiempo del período activo
   */
  getFilteredTransactions() {
    const now = new Date();

    if (this.activePeriod === 'all') {
      return state.transactions;
    }

    if (this.activePeriod === 'month') {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      return state.transactions.filter(t => new Date(t.timestamp) >= startOfMonth);
    }

    if (this.activePeriod === 'week') {
      const day = now.getDay();
      const diffToMonday = (day === 0 ? -6 : 1) - day;
      const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday, 0, 0, 0, 0);
      return state.transactions.filter(t => new Date(t.timestamp) >= startOfWeek);
    }

    return state.transactions;
  },

  /**
   * Renderiza el gráfico circular donut, las métricas KPI y el desglose ordenado
   */
  render() {
    const transactions = this.getFilteredTransactions();

    // 1. Cálculos agregados con Array.prototype.reduce
    const totalUSD = transactions.reduce((acc, t) => acc + (t.amountUSD || 0), 0);
    const count = transactions.length;
    const avgUSD = count > 0 ? totalUSD / count : 0;

    const totalsByCat = transactions.reduce((acc, t) => {
      const cat = t.category_id || t.category || 'otros';
      acc[cat] = (acc[cat] || 0) + (t.amountUSD || 0);
      return acc;
    }, {});

    // Ranking ordenado de mayor a menor gasto
    const sortedCategories = Object.entries(totalsByCat).map(([catId, amount], idx) => {
      const catInfo = CATEGORIES[catId] || { label: catId, icon: '📦' };
      const percentage = totalUSD > 0 ? (amount / totalUSD) * 100 : 0;
      return {
        id: catId,
        label: catInfo.label,
        icon: catInfo.icon,
        amount,
        percentage,
        color: this.getColor(catId, idx)
      };
    }).sort((a, b) => b.amount - a.amount);

    // 2. Actualizar tarjetas KPI
    if (this.elements.totalEl) this.elements.totalEl.textContent = `$${totalUSD.toFixed(2)}`;
    if (this.elements.avgEl) this.elements.avgEl.textContent = `$${avgUSD.toFixed(2)}`;
    if (this.elements.countEl) this.elements.countEl.textContent = `${count} ${count === 1 ? 'gasto' : 'gastos'}`;

    if (this.elements.topCatEl) {
      this.elements.topCatEl.textContent = sortedCategories.length > 0 ? sortedCategories[0].label : '-';
    }
    if (this.elements.topPctEl) {
      this.elements.topPctEl.textContent = sortedCategories.length > 0 ? `${sortedCategories[0].percentage.toFixed(1)}% del total` : '-';
    }

    // 3. Renderizar Gráfico Donut en SVG nativo
    this.renderDonutChart(sortedCategories, totalUSD);

    // 4. Renderizar Ranking y Leyenda Desglosada
    this.renderBreakdown(sortedCategories, totalUSD);
  },

  /**
   * Genera el SVG del gráfico donut dinámico o el estado vacío
   * @param {Array} categories - Categorías ordenadas con su porcentaje y monto
   * @param {number} totalUSD - Importe total gastado en USD
   */
  renderDonutChart(categories, totalUSD) {
    if (!this.elements.chartContainer) return;

    if (totalUSD <= 0 || categories.length === 0) {
      this.elements.chartContainer.innerHTML = `
        <div class="chart-empty-state">
          <div class="donut-svg-wrap">
            <svg viewBox="0 0 160 160" class="donut-svg">
              <circle cx="80" cy="80" r="54" fill="transparent" stroke="var(--border-subtle)" stroke-width="12" stroke-dasharray="4 4"></circle>
              <text x="80" y="76" text-anchor="middle" class="donut-center-total" fill="var(--text-subtle)">$0.00</text>
              <text x="80" y="93" text-anchor="middle" class="donut-center-label" fill="var(--text-subtle)">Sin gastos</text>
            </svg>
          </div>
          <p class="chart-empty-desc">No se encontraron movimientos registrados para este período.</p>
        </div>
      `;
      return;
    }

    // Dimensiones y cálculo de arcos SVG:
    // Radio R = 54 px, Centro = (80, 80)
    // Longitud de la circunferencia C = 2 * π * R = 2 * π * 54 ≈ 339.292 px
    const R = 54;
    const C = 2 * Math.PI * R; // ~339.292

    let accumulatedOffset = 0;

    const segmentsHTML = categories.map(cat => {
      // Longitud del arco del segmento según su proporción
      const segmentLength = (cat.percentage / 100) * C;
      const strokeDasharray = `${segmentLength.toFixed(3)} ${(C - segmentLength).toFixed(3)}`;
      const strokeDashoffset = (-accumulatedOffset).toFixed(3);
      accumulatedOffset += segmentLength;

      return `
        <circle 
          class="donut-segment" 
          cx="80" 
          cy="80" 
          r="${R}" 
          fill="transparent" 
          stroke="${cat.color}" 
          stroke-width="16" 
          stroke-dasharray="${strokeDasharray}" 
          stroke-dashoffset="${strokeDashoffset}" 
          transform="rotate(-90 80 80)"
        >
          <title>${escapeHtml(cat.label)}: $${cat.amount.toFixed(2)} (${cat.percentage.toFixed(1)}%)</title>
        </circle>
      `;
    }).join('');

    const periodNames = {
      week: 'Semana',
      month: 'Mes',
      all: 'Total'
    };
    const periodLabel = periodNames[this.activePeriod] || 'Mes';

    this.elements.chartContainer.innerHTML = `
      <div class="donut-svg-wrap">
        <svg viewBox="0 0 160 160" class="donut-svg" aria-label="Gráfico circular de distribución de gastos">
          <!-- Pista base sutil -->
          <circle cx="80" cy="80" r="${R}" fill="transparent" stroke="var(--border-subtle)" stroke-width="16" opacity="0.3"></circle>
          <!-- Segmentos proporcionales de categorías -->
          ${segmentsHTML}
          <!-- Texto central con total normalizado en USD -->
          <text x="80" y="75" text-anchor="middle" class="donut-center-total" fill="var(--text-primary)">$${totalUSD.toFixed(2)}</text>
          <text x="80" y="93" text-anchor="middle" class="donut-center-label" fill="var(--text-muted)">Total ${periodLabel}</text>
        </svg>
      </div>
    `;
  },

  /**
   * Renderiza la leyenda desglosada y barras de progreso por categoría
   */
  renderBreakdown(categories, totalUSD) {
    if (!this.elements.barsList) return;

    if (totalUSD <= 0 || categories.length === 0) {
      this.elements.barsList.innerHTML = `
        <div class="empty-breakdown-notice">
          Registra un nuevo gasto para visualizar el ranking de consumo.
        </div>
      `;
      return;
    }

    this.elements.barsList.innerHTML = categories.map(cat => `
      <div class="cat-bar-item">
        <div class="cat-bar-info">
          <span class="cat-bar-name">
            <span class="cat-bar-dot" style="background-color: ${cat.color};"></span>
            <span class="cat-bar-icon">${cat.icon}</span>
            <span>${escapeHtml(cat.label)}</span>
          </span>
          <span class="cat-bar-amount">
            <strong class="cat-bar-percent">${cat.percentage.toFixed(0)}%</strong>
            <span class="cat-bar-usd">$${cat.amount.toFixed(2)} USD</span>
          </span>
        </div>
        <div class="cat-bar-track">
          <div 
            class="cat-bar-fill" 
            style="width: ${cat.percentage.toFixed(1)}%; background-color: ${cat.color};"
          ></div>
        </div>
      </div>
    `).join('');
  }
};

// ============================================================================
// 8. GESTOR DINÁMICO DE CATEGORÍAS (categoryManager)
// ============================================================================
const categoryManager = {
  elements: {
    container: null,
    historyFilters: null,
    modal: null,
    closeBtn: null,
    createForm: null,
    nameInput: null,
    iconInput: null,
    emojiGrid: null,
    manageList: null,
    countBadge: null
  },

  /**
   * Convierte un texto en un slug alfanumérico limpio
   * @param {string} text - Texto base
   * @returns {string} - Slug resultante (ej. "salud-y-belleza")
   */
  slugify(text) {
    if (!text) return 'cat-' + Date.now().toString(36);
    const clean = text
      .toString()
      .toLowerCase()
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Eliminar tildes y diacríticos
      .replace(/[^a-z0-9\s-]/g, '')    // Eliminar caracteres especiales
      .replace(/\s+/g, '-')           // Reemplazar espacios por guiones
      .replace(/-+/g, '-');           // Colapsar guiones múltiples
    return clean || ('cat-' + Date.now().toString(36));
  },

  /**
   * Inicializa el ciclo de vida de categorías:
   * 1. Carga desde localStorage o inicializa con las 6 por defecto.
   * 2. Sincroniza el mapa CATEGORIES para compatibilidad completa.
   * 3. Renderiza los chips en el formulario y los filtros en el historial.
   * 4. Enlaza los listeners del modal de administración.
   */
  init() {
    this.elements.container = document.getElementById('category-options-container');
    this.elements.historyFilters = document.getElementById('history-filters-container') || document.querySelector('.history-filters');
    this.elements.modal = document.getElementById('category-modal');
    this.elements.closeBtn = document.getElementById('btn-close-category-modal');
    this.elements.createForm = document.getElementById('category-create-form');
    this.elements.nameInput = document.getElementById('new-cat-name');
    this.elements.iconInput = document.getElementById('new-cat-icon');
    this.elements.emojiGrid = document.getElementById('quick-emoji-grid');
    this.elements.manageList = document.getElementById('category-management-list');
    this.elements.countBadge = document.getElementById('cat-count-badge');

    // 1. Cargar datos persistidos
    this.loadFromStorage();
    this.syncLookup();

    // 2. Renderizado dinámico en DOM
    this.renderFormCategories();
    this.renderHistoryFilters();
    this.renderManagementList();

    // 3. Suscribir listeners de cierre y modal
    if (this.elements.closeBtn) {
      this.elements.closeBtn.addEventListener('click', () => this.closeModal());
    }

    if (this.elements.modal) {
      this.elements.modal.addEventListener('click', (e) => {
        if (e.target === this.elements.modal) {
          this.closeModal();
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isModalOpen()) {
        this.closeModal();
      }
    });

    // Selector rápido de emojis en el modal
    if (this.elements.emojiGrid) {
      this.elements.emojiGrid.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-emoji]');
        if (!btn) return;
        const emoji = btn.getAttribute('data-emoji');
        if (this.elements.iconInput) {
          this.elements.iconInput.value = emoji;
        }
        this.elements.emojiGrid.querySelectorAll('.emoji-chip').forEach(c => c.classList.remove('is-selected'));
        btn.classList.add('is-selected');
      });
    }

    // Envío del formulario para crear nueva categoría
    if (this.elements.createForm) {
      this.elements.createForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const label = this.elements.nameInput ? this.elements.nameInput.value : '';
        const icon = this.elements.iconInput ? this.elements.iconInput.value : '🏷️';
        if (this.addCategory({ label, icon })) {
          if (this.elements.nameInput) this.elements.nameInput.value = '';
          if (this.elements.iconInput) this.elements.iconInput.value = '🏷️';
          if (this.elements.emojiGrid) {
            this.elements.emojiGrid.querySelectorAll('.emoji-chip').forEach((c, idx) => {
              c.classList.toggle('is-selected', idx === 0);
            });
          }
        }
      });
    }

    // Delegación de clics para eliminar categorías en el modal
    if (this.elements.manageList) {
      this.elements.manageList.addEventListener('click', (e) => {
        const delBtn = e.target.closest('[data-delete-cat-id]');
        if (!delBtn) return;
        const catId = delBtn.getAttribute('data-delete-cat-id');
        if (catId) {
          this.deleteCategory(catId);
        }
      });
    }
  },

  /**
   * Carga categorías desde Supabase o hace fallback a localStorage
   * @param {string} userId
   */
  async loadFromSupabase(userId) {
    const client = window.supabaseClient;
    if (!client || !userId) {
      this.loadFromStorage();
      return;
    }

    try {
      const { data, error } = await client
        .from('categories')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });

      if (error) {
        console.warn('[categoryManager] Error cargando de Supabase:', error.message);
        this.loadFromStorage();
        return;
      }

      if (Array.isArray(data) && data.length > 0) {
        state.categories = data.map(c => ({
          id: c.id,
          label: c.name,
          name: c.name,
          icon: c.icon || '🏷️',
          color: c.color || '#64748b',
          isDefault: !!c.is_default,
          is_default: !!c.is_default
        }));

        this.saveToStorage();
        this.syncLookup();
        this.renderFormCategories();
        this.renderHistoryFilters();
        this.renderManagementList();
        return;
      }
    } catch (err) {
      console.warn('[categoryManager] Excepción al consultar Supabase:', err);
    }

    this.loadFromStorage();
  },

  /**
   * Carga categorías desde localStorage o aplica las predeterminadas
   */
  loadFromStorage() {
    try {
      const user = window.authManager?.currentUser;
      const storageKey = user ? `gastosya_cat_${user.id}` : CATEGORIES_STORAGE_KEY;
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          state.categories = parsed;
          return;
        }
      }
    } catch (e) {
      console.warn('[categoryManager] Error leyendo de localStorage:', e);
    }
    // Inicialización por defecto
    state.categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
    this.saveToStorage();
  },

  /**
   * Guarda las categorías en localStorage
   */
  saveToStorage() {
    try {
      const user = window.authManager?.currentUser;
      const storageKey = user ? `gastosya_cat_${user.id}` : CATEGORIES_STORAGE_KEY;
      localStorage.setItem(storageKey, JSON.stringify(state.categories));
    } catch (e) {
      console.error('[categoryManager] Error guardando categorías en localStorage:', e);
    }
  },

  /**
   * Sincroniza el mapa global CATEGORIES para renderizado de movimientos
   */
  syncLookup() {
    CATEGORIES = {};
    (state.categories || []).forEach(c => {
      CATEGORIES[c.id] = {
        label: c.label || c.name,
        icon: c.icon,
        badgeClass: `cat-${c.id}`,
        color: c.color,
        isDefault: !!c.isDefault
      };
      // Soporte retroactivo para nombres en minúscula
      if (c.name) {
        CATEGORIES[c.name.toLowerCase()] = CATEGORIES[c.id];
      }
    });
  },

  /**
   * Renderiza dinámicamente los chips de categoría en el formulario
   */
  renderFormCategories() {
    if (!this.elements.container) return;

    if (!state.categories || state.categories.length === 0) {
      state.categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
    }

    // Garantizar que exista una categoría seleccionada válida
    const exists = state.categories.some(c => c.id === state.selectedCategory);
    if (!exists) {
      state.selectedCategory = state.categories[0].id;
    }

    const itemsHTML = state.categories.map(cat => {
      const isChecked = cat.id === state.selectedCategory;
      return `
        <input 
          type="radio" 
          name="category" 
          id="cat-${cat.id}" 
          value="${cat.id}" 
          ${isChecked ? 'checked' : ''} 
          class="visually-hidden"
        >
        <label for="cat-${cat.id}" class="category-pill" title="${escapeHtml(cat.label)}">
          <span class="cat-icon">${cat.icon}</span>
          <span class="cat-text">${escapeHtml(cat.label)}</span>
        </label>
      `;
    }).join('');

    const addBtnHTML = `
      <button type="button" class="category-add-btn" id="btn-manage-categories" aria-label="Gestionar o añadir categorías" title="Gestionar categorías">
        <span class="cat-add-icon">➕</span>
        <span class="cat-add-text">+ Nueva</span>
      </button>
    `;

    this.elements.container.innerHTML = itemsHTML + addBtnHTML;

    // Conectar botón de gestionar
    const manageBtn = document.getElementById('btn-manage-categories');
    if (manageBtn) {
      manageBtn.addEventListener('click', () => this.openModal());
    }
  },

  /**
   * Renderiza dinámicamente los filtros de categoría en la vista de historial
   */
  renderHistoryFilters() {
    if (!this.elements.historyFilters) return;

    const currentFilter = state.activeCategoryFilter || 'all';

    const allBtn = `
      <button type="button" class="filter-chip ${currentFilter === 'all' ? 'is-active' : ''}" data-filter="all">
        Todos
      </button>
    `;

    const catChips = (state.categories || []).map(cat => `
      <button type="button" class="filter-chip ${currentFilter === cat.id ? 'is-active' : ''}" data-filter="${cat.id}">
        ${cat.icon} ${escapeHtml(cat.label)}
      </button>
    `).join('');

    this.elements.historyFilters.innerHTML = allBtn + catChips;
  },

  /**
   * Renderiza la lista de categorías activas en el modal
   */
  renderManagementList() {
    if (!this.elements.manageList) return;

    if (this.elements.countBadge) {
      this.elements.countBadge.textContent = state.categories.length;
    }

    this.elements.manageList.innerHTML = (state.categories || []).map(cat => `
      <div class="category-manage-item" role="listitem">
        <div class="cat-manage-info">
          <span class="cat-manage-icon">${cat.icon}</span>
          <span class="cat-manage-name">${escapeHtml(cat.label)}</span>
          ${cat.isDefault ? '<span class="cat-base-tag" title="Categoría inicial">Inicial</span>' : ''}
        </div>
        <button type="button" class="btn-delete-cat" data-delete-cat-id="${cat.id}" aria-label="Eliminar categoría ${escapeHtml(cat.label)}" title="Eliminar categoría">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    `).join('');
  },

  /**
   * Añade una nueva categoría definida por el usuario
   */
  /**
   * Añade una nueva categoría definida por el usuario
   */
  async addCategory({ label, icon }) {
    const trimmedLabel = (label || '').trim();
    if (!trimmedLabel) {
      if (this.elements.nameInput) {
        this.elements.nameInput.focus();
        this.elements.nameInput.classList.add('input-error');
        setTimeout(() => this.elements.nameInput.classList.remove('input-error'), 1000);
      }
      return false;
    }

    const client = window.supabaseClient;
    const user = window.authManager?.currentUser;
    const isOnline = window.syncManager ? window.syncManager.isOnline() : navigator.onLine;

    let newId = generateUUID();
    let isDefault = false;

    if (client && user && isOnline) {
      try {
        const { data, error } = await client
          .from('categories')
          .insert([{
            user_id: user.id,
            name: trimmedLabel,
            icon: (icon || '🏷️').trim() || '🏷️',
            color: '#64748b',
            is_default: false
          }])
          .select()
          .single();

        if (error) {
          console.error('[categoryManager] Error insertando categoría en Supabase:', error.message);
          if (error.code === '23505') {
            alert('Ya existe una categoría con ese nombre.');
            return false;
          }
        } else if (data) {
          newId = data.id;
          isDefault = data.is_default;
        }
      } catch (err) {
        console.warn('[categoryManager] Excepción al guardar categoría en Supabase:', err);
      }
    }

    const newCat = {
      id: newId,
      label: trimmedLabel,
      name: trimmedLabel,
      icon: (icon || '🏷️').trim() || '🏷️',
      isDefault: isDefault,
      is_default: isDefault
    };

    state.categories.push(newCat);
    state.selectedCategory = newCat.id;

    this.saveToStorage();
    this.syncLookup();
    this.renderFormCategories();
    this.renderHistoryFilters();
    this.renderManagementList();

    this.closeModal();
    return true;
  },

  /**
   * Elimina una categoría si no es la última disponible
   */
  async deleteCategory(id) {
    const cat = state.categories.find(c => c.id === id);
    if (!cat) return false;

    if (state.categories.length <= 1) {
      alert('Debes mantener al menos una categoría en tu cuenta.');
      return false;
    }

    const client = window.supabaseClient;
    const isOnline = window.syncManager ? window.syncManager.isOnline() : navigator.onLine;

    if (client && isOnline) {
      try {
        const { error } = await client
          .from('categories')
          .delete()
          .eq('id', id);

        if (error) {
          console.error('[categoryManager] Error eliminando categoría en Supabase:', error.message);
        }
      } catch (err) {
        console.warn('[categoryManager] Excepción al eliminar categoría en Supabase:', err);
      }
    }

    state.categories = state.categories.filter(c => c.id !== id);

    // Si la categoría eliminada estaba seleccionada, cambiar a la primera disponible
    if (state.selectedCategory === id) {
      state.selectedCategory = state.categories[0]?.id || '';
    }

    // Si el filtro de historial correspondía a la categoría borrada, resetear a 'all'
    if (state.activeCategoryFilter === id) {
      state.activeCategoryFilter = 'all';
      render.transactionsFeed();
    }

    this.saveToStorage();
    this.syncLookup();
    this.renderFormCategories();
    this.renderHistoryFilters();
    this.renderManagementList();

    return true;
  },

  /**
   * Abre el modal de administración de categorías
   */
  openModal() {
    if (!this.elements.modal) return;
    this.renderManagementList();
    this.elements.modal.classList.add('is-open');
    this.elements.modal.setAttribute('aria-hidden', 'false');
    if (this.elements.nameInput) {
      setTimeout(() => this.elements.nameInput.focus(), 80);
    }
  },

  /**
   * Cierra el modal de administración de categorías
   */
  closeModal() {
    if (!this.elements.modal) return;
    this.elements.modal.classList.remove('is-open');
    this.elements.modal.setAttribute('aria-hidden', 'true');
    const manageBtn = document.getElementById('btn-manage-categories');
    if (manageBtn) {
      manageBtn.focus();
    }
  },

  /**
   * Retorna true si el modal está abierto
   */
  isModalOpen() {
    return this.elements.modal && this.elements.modal.classList.contains('is-open');
  }
};

// ============================================================================
// 9. SISTEMA DE TEMAS VISUALES SUAVES (Theming Engine / themeManager)
// ============================================================================
const themeManager = {
  // Clave de almacenamiento persistente en localStorage
  STORAGE_KEY: 'gastosya_theme',
  
  // Tema predeterminado
  DEFAULT_THEME: 'dark-slate',

  // Catálogo de temas suaves soportados (8 paletas completas)
  AVAILABLE_THEMES: [
    'dark-slate',
    'lila',
    'beige',
    'rosa',
    'cian',
    'verde',
    'nordic',
    'oled'
  ],

  // Referencias cacheadas del DOM
  elements: {
    modal: null,
    triggerBtn: null,
    closeBtn: null,
    optionButtons: []
  },

  currentTheme: 'dark-slate',

  /**
   * Inicializa el motor de temas:
   * - Cachea nodos del modal y botones de opciones.
   * - Lee la preferencia en localStorage ('gastosya_theme') o usa 'dark-slate'.
   * - Aplica el tema inmediatamente a document.documentElement.
   * - Configura la accesibilidad y eventos (apertura, cierre por botón, Escape y clic exterior).
   */
  init() {
    this.elements.modal = document.getElementById('modal-settings') || document.getElementById('theme-modal');
    this.elements.triggerBtn = document.getElementById('btn-open-settings') || document.getElementById('btn-settings');
    this.elements.closeBtn = document.getElementById('btn-close-settings-modal') || document.getElementById('btn-close-theme-modal');
    this.elements.optionButtons = Array.from(document.querySelectorAll('.theme-option-btn'));

    // Leer tema de localStorage con verificación estricta de lista permitida
    let savedTheme = this.DEFAULT_THEME;
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (stored && this.AVAILABLE_THEMES.includes(stored)) {
        savedTheme = stored;
      }
    } catch (e) {
      console.warn('[themeManager] Error leyendo de localStorage:', e);
    }

    // Aplicar tema inicial inmediatamente
    this.applyTheme(savedTheme, false);

    // Enlazar eventos de apertura y cierre
    if (this.elements.triggerBtn) {
      this.elements.triggerBtn.addEventListener('click', () => this.openModal());
    }

    if (this.elements.closeBtn) {
      this.elements.closeBtn.addEventListener('click', () => this.closeModal());
    }

    // Cerrar haciendo clic en el fondo oscuro (backdrop)
    if (this.elements.modal) {
      this.elements.modal.addEventListener('click', (event) => {
        if (event.target === this.elements.modal) {
          this.closeModal();
        }
      });
    }

    // Cerrar mediante la tecla Escape
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isModalOpen()) {
        this.closeModal();
      }
    });

    // Delegación y listeners directos en los botones de selección
    this.elements.optionButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const selectedTheme = btn.dataset.themeId;
        if (selectedTheme && this.AVAILABLE_THEMES.includes(selectedTheme)) {
          this.applyTheme(selectedTheme, true);
        }
      });
    });
  },

  /**
   * Aplica un tema visual al documento y sincroniza la UI y persistencia
   * @param {string} themeName - Nombre del tema a aplicar
   * @param {boolean} persist - Indica si debe persistirse en localStorage
   */
  applyTheme(themeName, persist = true) {
    if (!this.AVAILABLE_THEMES.includes(themeName)) {
      themeName = this.DEFAULT_THEME;
    }

    this.currentTheme = themeName;

    // Aplicar data-theme al elemento raíz <html>
    document.documentElement.setAttribute('data-theme', themeName);

    // Sincronizar estado visual de los botones del selector
    this.elements.optionButtons.forEach(btn => {
      const isSelected = btn.dataset.themeId === themeName;
      btn.classList.toggle('is-active', isSelected);
      btn.setAttribute('aria-checked', isSelected ? 'true' : 'false');
    });

    // Guardar preferencia en localStorage bajo 'gastosya_theme'
    if (persist) {
      try {
        localStorage.setItem(this.STORAGE_KEY, themeName);
      } catch (e) {
        console.warn('[themeManager] No se pudo persistir el tema en localStorage:', e);
      }
    }
  },

  /**
   * Abre el panel/modal de configuración y gestiona el foco
   */
  openModal() {
    if (!this.elements.modal) return;
    this.elements.modal.classList.add('is-open');
    this.elements.modal.setAttribute('aria-hidden', 'false');

    if (this.elements.triggerBtn) {
      this.elements.triggerBtn.setAttribute('aria-expanded', 'true');
    }

    // Sincronizar reactivamente datos de cuenta de usuario al abrir el modal
    if (window.authManager && typeof window.authManager.updateUserSessionUI === 'function') {
      const user = window.authManager.currentUser;
      window.authManager.updateUserSessionUI(user?.email || null);
    }

    // Foco ergonómico en la opción activa actual o en el botón de cerrar
    const activeBtn = this.elements.optionButtons.find(btn => btn.dataset.themeId === this.currentTheme);
    if (activeBtn) {
      activeBtn.focus();
    } else if (this.elements.closeBtn) {
      this.elements.closeBtn.focus();
    }
  },

  /**
   * Cierra el panel/modal de configuración y devuelve el foco
   */
  closeModal() {
    if (!this.elements.modal) return;
    this.elements.modal.classList.remove('is-open');
    this.elements.modal.setAttribute('aria-hidden', 'true');

    if (this.elements.triggerBtn) {
      this.elements.triggerBtn.setAttribute('aria-expanded', 'false');
      this.elements.triggerBtn.focus();
    }
  },

  /**
   * Verifica si el modal está visible en pantalla
   */
  isModalOpen() {
    return this.elements.modal && this.elements.modal.classList.contains('is-open');
  }
};

// Exponer globalmente para coordinación con authManager
window.themeManager = themeManager;

// ============================================================================
// 10. INICIALIZACIÓN DE LA APLICACIÓN (App Boot)
// ============================================================================

// Suscripción al ciclo de autenticación para sincronizar datos por usuario
window.addEventListener('gastosya:auth-changed', async (event) => {
  const { session, user } = event.detail || {};
  if (session && user) {
    console.log(`⚡ [GastosYa] Sesión activa para: ${user.email}`);
    await categoryManager.loadFromSupabase(user.id);
    await loadTransactionsFromSupabase(user.id);
    if (window.syncManager && window.syncManager.isOnline()) {
      window.syncManager.syncPendingQueue();
    }
  } else {
    console.log('🔒 [GastosYa] Sesión finalizada. Limpiando estado local.');
    state.transactions = [];
    state.categories = [];
    CATEGORIES = {};
    render.transactionsFeed();
    analyticsManager.render();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  // 1. Cargar datos locales (inicialmente vacío para usuarios nuevos)
  loadTransactionsFromStorage();

  // 2. Inicializar gestor dinámico de categorías
  categoryManager.init();

  // 3. Establecer valores iniciales del estado
  state.currentCurrency = 'VES';
  state.currentRateType = 'BCV';
  state.currentRateValue = state.rates.BCV;

  // 4. Renderizar componentes iniciales
  render.currencySymbol();
  render.rateSectionVisibility();
  render.rateValueInput();
  render.livePreview();
  render.transactionsFeed();

  // 5. Suscripción a eventos del DOM
  const { form, amountInput, rateValueInput, movementsList } = render.elements;

  if (amountInput) {
    amountInput.addEventListener('input', handlers.onAmountInput);
  }

  // Escuchar cambios en radios de moneda, tasas y categorías (delegación en form)
  if (form) {
    form.addEventListener('change', (e) => {
      if (e.target.name === 'currencyOriginal') {
        handlers.onCurrencyChange(e);
      } else if (e.target.name === 'rateType') {
        handlers.onRateTypeChange(e);
      } else if (e.target.name === 'category') {
        state.selectedCategory = e.target.value;
      }
    });

    form.addEventListener('submit', (e) => handlers.onFormSubmit(e));
  }

  if (rateValueInput) {
    rateValueInput.addEventListener('input', handlers.onRateValueInput);
  }

  if (movementsList) {
    movementsList.addEventListener('click', (e) => handlers.onMovementsListClick(e));
  }

  // 6. Inicializar sistema de navegación de pestañas y filtros
  navigation.init();

  // 7. Inicializar sistema de temas visuales suaves (Theming Engine)
  themeManager.init();

  // 8. Inicializar módulo de análisis financiero y gráfico donut
  analyticsManager.init();

  const historyFilters = document.querySelector('.history-filters');
  if (historyFilters) {
    historyFilters.addEventListener('click', handlers.onFilterClick);
  }

  // Exponer objetos clave para coordinación global y pruebas
  window.state = state;
  window.calculator = calculator;
  window.render = render;
  window.categoryManager = categoryManager;
  window.analyticsManager = analyticsManager;
});
