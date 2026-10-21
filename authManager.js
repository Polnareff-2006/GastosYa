/**
 * ============================================================================
 * GastosYa - Gestor de Autenticación Reactiva (Fase 4.2)
 * ============================================================================
 * Maneja el ciclo de vida de autenticación de usuarios (registro, inicio de sesión,
 * cierre de sesión, persistencia de tokens) y sincroniza reactivamente la UI
 * mediante el listener onAuthStateChange de Supabase.
 * ============================================================================
 */

'use strict';

const authManager = {
  // Estado local del gestor
  currentUser: null,
  currentSession: null,
  currentMode: 'login', // 'login' | 'signup'
  isLoading: false,

  // Referencias cacheadas del DOM
  elements: {},

  /**
   * Inicializa el módulo de autenticación y escucha eventos reactivos
   */
  async init() {
    this.cacheElements();
    this.bindEvents();

    const client = window.supabaseClient;

    // Verificar si las credenciales de Supabase aún son marcadores de posición
    if (this.isPlaceholderConfig()) {
      this.showAlert(
        'Configura tu SUPABASE_URL y SUPABASE_ANON_KEY en supabaseClient.js (líneas 16-17) para habilitar el registro e inicio de sesión en Supabase.',
        'warning'
      );
      this.lockApp(true);
      return;
    }

    if (!client) {
      this.showAlert(
        'No se pudo conectar con el cliente de Supabase. Verifica tu conexión de red.',
        'error'
      );
      this.lockApp(true);
      return;
    }

    try {
      // 1. Verificar sesión existente al arrancar la app
      const { data: { session }, error } = await client.auth.getSession();
      if (error) {
        console.warn('⚠️ [GastosYa Auth] Error obteniendo sesión inicial:', error.message);
      }

      if (session) {
        this.handleSessionUpdate('INITIAL_SESSION', session);
      } else {
        this.handleSessionUpdate('NO_SESSION', null);
      }

      // 2. Suscripción reactiva al ciclo de vida de autenticación
      client.auth.onAuthStateChange((event, session) => {
        console.log(`⚡ [GastosYa Auth] Evento onAuthStateChange: ${event}`);
        this.handleSessionUpdate(event, session);
      });
    } catch (err) {
      console.error('❌ [GastosYa Auth] Error en inicialización reactiva:', err);
      this.lockApp(true);
    }
  },

  /**
   * Almacena referencias a los nodos del DOM de autenticación
   */
  cacheElements() {
    this.elements = {
      modal: document.getElementById('modal-auth'),
      form: document.getElementById('auth-form'),
      tabLogin: document.getElementById('tab-login'),
      tabSignup: document.getElementById('tab-signup'),
      headerTitle: document.getElementById('auth-header-title'),
      headerSubtitle: document.getElementById('auth-header-subtitle'),
      emailInput: document.getElementById('auth-email'),
      passwordInput: document.getElementById('auth-password'),
      btnSubmit: document.getElementById('btn-auth-submit'),
      btnSubmitText: document.getElementById('auth-btn-text'),
      btnSubmitSpinner: document.getElementById('auth-btn-spinner'),
      alertBox: document.getElementById('auth-alert-box'),
      alertIcon: document.getElementById('auth-alert-icon'),
      alertMessage: document.getElementById('auth-alert-message'),
      switchPrompt: document.getElementById('auth-switch-prompt'),
      btnSwitchMode: document.getElementById('btn-auth-switch-mode'),
      btnTogglePassword: document.getElementById('btn-toggle-password'),
      settingsModal: document.getElementById('modal-settings'),
      settingsUserEmail: document.getElementById('settings-user-email'),
      settingsAccountStatus: document.getElementById('settings-account-status'),
      btnLogoutModal: document.getElementById('btn-logout-modal'),
      userSessionInfo: document.getElementById('user-session-info'),
      userEmailDisplay: document.getElementById('user-email-display'),
      btnLogout: document.getElementById('btn-logout')
    };
  },

  /**
   * Registra los manejadores de eventos del DOM
   */
  bindEvents() {
    const {
      form,
      tabLogin,
      tabSignup,
      btnSwitchMode,
      btnTogglePassword,
      btnLogoutModal,
      btnLogout
    } = this.elements;

    // Pestaña Iniciar Sesión
    if (tabLogin) {
      tabLogin.addEventListener('click', () => this.setMode('login'));
    }

    // Pestaña Crear Cuenta
    if (tabSignup) {
      tabSignup.addEventListener('click', () => this.setMode('signup'));
    }

    // Enlace alternativo en el pie del modal
    if (btnSwitchMode) {
      btnSwitchMode.addEventListener('click', () => {
        this.setMode(this.currentMode === 'login' ? 'signup' : 'login');
      });
    }

    // Alternar visibilidad de contraseña
    if (btnTogglePassword) {
      btnTogglePassword.addEventListener('click', () => this.togglePasswordVisibility());
    }

    // Envío del formulario de autenticación
    if (form) {
      form.addEventListener('submit', (e) => this.handleSubmit(e));
    }

    // Botón Cerrar Sesión en modal de configuración
    if (btnLogoutModal) {
      btnLogoutModal.addEventListener('click', () => this.signOut());
    }

    // Botón Cerrar Sesión fallback
    if (btnLogout) {
      btnLogout.addEventListener('click', () => this.signOut());
    }
  },

  /**
   * Cambia el modo visual del formulario entre login y registro
   * @param {'login' | 'signup'} mode
   */
  setMode(mode) {
    this.currentMode = mode;
    this.clearAlert();

    const {
      tabLogin,
      tabSignup,
      headerTitle,
      headerSubtitle,
      btnSubmitText,
      switchPrompt,
      btnSwitchMode
    } = this.elements;

    if (mode === 'signup') {
      if (tabSignup) tabSignup.classList.add('is-active');
      if (tabLogin) tabLogin.classList.remove('is-active');
      if (tabSignup) tabSignup.setAttribute('aria-selected', 'true');
      if (tabLogin) tabLogin.setAttribute('aria-selected', 'false');

      if (headerTitle) headerTitle.textContent = 'Crear Cuenta';
      if (headerSubtitle) headerSubtitle.textContent = 'Regístrate para respaldar y organizar tus gastos';
      if (btnSubmitText) btnSubmitText.textContent = 'Crear Cuenta Gratuita';
      if (switchPrompt) switchPrompt.textContent = '¿Ya tienes una cuenta?';
      if (btnSwitchMode) btnSwitchMode.textContent = 'Inicia sesión';
    } else {
      if (tabLogin) tabLogin.classList.add('is-active');
      if (tabSignup) tabSignup.classList.remove('is-active');
      if (tabLogin) tabLogin.setAttribute('aria-selected', 'true');
      if (tabSignup) tabSignup.setAttribute('aria-selected', 'false');

      if (headerTitle) headerTitle.textContent = 'Iniciar Sesión';
      if (headerSubtitle) headerSubtitle.textContent = 'Accede a tus gastos y sincroniza tus datos';
      if (btnSubmitText) btnSubmitText.textContent = 'Iniciar Sesión';
      if (switchPrompt) switchPrompt.textContent = '¿No tienes cuenta todavía?';
      if (btnSwitchMode) btnSwitchMode.textContent = 'Regístrate gratis';
    }
  },

  /**
   * Procesa el submit del formulario de login / registro
   */
  async handleSubmit(e) {
    e.preventDefault();
    this.clearAlert();

    if (this.isPlaceholderConfig()) {
      this.showAlert(
        'Configura tus credenciales reales en supabaseClient.js (Líneas 16-17) antes de continuar.',
        'warning'
      );
      return;
    }

    const email = (this.elements.emailInput?.value || '').trim();
    const password = this.elements.passwordInput?.value || '';

    // Validaciones básicas de cliente
    if (!email || !password) {
      this.showAlert('Por favor, ingresa tu correo y tu contraseña.', 'error');
      return;
    }

    if (password.length < 6) {
      this.showAlert('La contraseña debe tener un mínimo de 6 caracteres.', 'error');
      return;
    }

    this.setLoading(true);

    try {
      if (this.currentMode === 'signup') {
        const { data, error } = await this.signUp(email, password);
        if (error) {
          this.showAlert(this.formatErrorMessage(error), 'error');
        } else {
          // Si el usuario requiere confirmación por email
          if (data?.user && (!data.session || data.user.identities?.length === 0)) {
            this.showAlert(
              '¡Cuenta creada con éxito! Si tu proyecto tiene confirmación de correo habilitada, revisa tu bandeja de entrada para verificar tu cuenta.',
              'success'
            );
          } else {
            this.showAlert('¡Cuenta creada e iniciada exitosamente!', 'success');
          }
        }
      } else {
        const { error } = await this.signIn(email, password);
        if (error) {
          this.showAlert(this.formatErrorMessage(error), 'error');
        }
      }
    } catch (err) {
      console.error('❌ [GastosYa Auth] Error en submit:', err);
      this.showAlert('Ocurrió un error inesperado al procesar la solicitud. Revisa tu conexión.', 'error');
    } finally {
      this.setLoading(false);
    }
  },

  /**
   * Registra un nuevo usuario en Supabase Auth
   * @param {string} email
   * @param {string} password
   */
  async signUp(email, password) {
    const client = window.supabaseClient;
    if (!client) throw new Error('Cliente de Supabase no disponible');
    return await client.auth.signUp({
      email,
      password
    });
  },

  /**
   * Inicia sesión con email y contraseña en Supabase Auth
   * @param {string} email
   * @param {string} password
   */
  async signIn(email, password) {
    const client = window.supabaseClient;
    if (!client) throw new Error('Cliente de Supabase no disponible');
    return await client.auth.signInWithPassword({
      email,
      password
    });
  },

  /**
   * Cierra la sesión activa del usuario
   */
  async signOut() {
    // Cerrar modal de ajustes si está abierto
    const settingsModal = this.elements.settingsModal || document.getElementById('modal-settings');
    if (settingsModal) {
      settingsModal.classList.remove('is-open');
      settingsModal.setAttribute('aria-hidden', 'true');
    }
    if (window.themeManager && typeof window.themeManager.closeModal === 'function') {
      window.themeManager.closeModal();
    }

    const client = window.supabaseClient;
    if (!client) {
      this.handleSessionUpdate('SIGNED_OUT', null);
      return;
    }

    try {
      this.setLoading(true);
      const { error } = await client.auth.signOut();
      if (error) {
        console.error('⚠️ [GastosYa Auth] Error en signOut:', error.message);
      }
    } catch (err) {
      console.error('❌ [GastosYa Auth] Excepción en signOut:', err);
    } finally {
      this.setLoading(false);
    }
  },

  /**
   * Devuelve el usuario actualmente autenticado o null
   */
  async getCurrentUser() {
    if (this.currentUser) return this.currentUser;
    const client = window.supabaseClient;
    if (!client) return null;

    try {
      const { data: { user } } = await client.auth.getUser();
      this.currentUser = user;
      return user;
    } catch (err) {
      return null;
    }
  },

  /**
   * Gestiona reactivamente los cambios de sesión emitidos por Supabase
   * @param {string} event
   * @param {object|null} session
   */
  handleSessionUpdate(event, session) {
    this.currentSession = session;
    this.currentUser = session?.user || null;

    if (session && session.user) {
      // Usuario autenticado: desbloquear app y cerrar modal de login
      this.lockApp(false);
      this.updateUserSessionUI(session.user.email);
      this.clearAlert();
      if (this.elements.form) {
        this.elements.form.reset();
      }
    } else {
      // Sin sesión: cerrar modal de ajustes si estuviera abierto, bloquear app y abrir login
      const settingsModal = this.elements.settingsModal || document.getElementById('modal-settings');
      if (settingsModal) {
        settingsModal.classList.remove('is-open');
        settingsModal.setAttribute('aria-hidden', 'true');
      }
      this.lockApp(true);
      this.updateUserSessionUI(null);
    }

    // Notificar al resto de la aplicación vía evento desacoplado
    window.dispatchEvent(new CustomEvent('gastosya:auth-changed', {
      detail: {
        event,
        session,
        user: this.currentUser
      }
    }));
  },

  /**
   * Actualiza el indicador de sesión tanto en el modal de configuración como en la app
   * @param {string|null} email
   */
  updateUserSessionUI(email) {
    const {
      settingsUserEmail,
      settingsAccountStatus,
      userSessionInfo,
      userEmailDisplay
    } = this.elements;

    if (email) {
      if (settingsUserEmail) settingsUserEmail.textContent = email;
      if (settingsAccountStatus) settingsAccountStatus.textContent = 'Sesión activa y sincronizada';
      if (userSessionInfo) userSessionInfo.style.display = 'inline-flex';
      if (userEmailDisplay) userEmailDisplay.textContent = email;
    } else {
      if (settingsUserEmail) settingsUserEmail.textContent = 'Sin sesión iniciada';
      if (settingsAccountStatus) settingsAccountStatus.textContent = 'No conectado';
      if (userSessionInfo) userSessionInfo.style.display = 'none';
      if (userEmailDisplay) userEmailDisplay.textContent = '';
    }
  },

  /**
   * Bloquea o desbloquea el flujo principal de la aplicación
   * @param {boolean} locked
   */
  lockApp(locked) {
    const modal = this.elements.modal;

    if (locked) {
      document.body.classList.add('auth-locked');
      if (modal) {
        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden', 'false');
      }
    } else {
      document.body.classList.remove('auth-locked');
      if (modal) {
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
      }
    }
  },

  /**
   * Alterna la visibilidad del input de contraseña
   */
  togglePasswordVisibility() {
    const input = this.elements.passwordInput;
    if (!input) return;

    if (input.type === 'password') {
      input.type = 'text';
    } else {
      input.type = 'password';
    }
  },

  /**
   * Muestra u oculta el estado de carga en el botón de submit
   * @param {boolean} loading
   */
  setLoading(loading) {
    this.isLoading = loading;
    const { btnSubmit, btnSubmitSpinner, btnSubmitText } = this.elements;

    if (!btnSubmit) return;

    btnSubmit.disabled = loading;
    if (btnSubmitSpinner) {
      btnSubmitSpinner.style.display = loading ? 'inline-block' : 'none';
    }
    if (btnSubmitText) {
      btnSubmitText.style.opacity = loading ? '0.75' : '1';
    }
  },

  /**
   * Despliega un mensaje en la caja de alertas del modal
   * @param {string} message
   * @param {'error' | 'success' | 'warning'} type
   */
  showAlert(message, type = 'error') {
    const { alertBox, alertIcon, alertMessage } = this.elements;
    if (!alertBox || !alertMessage) return;

    alertBox.className = `auth-alert-box is-${type}`;
    if (alertIcon) {
      alertIcon.textContent = type === 'success' ? '✅' : type === 'warning' ? '⚠️' : '⛔';
    }
    alertMessage.textContent = message;
    alertBox.style.display = 'flex';
  },

  /**
   * Oculta el mensaje de alerta
   */
  clearAlert() {
    const { alertBox } = this.elements;
    if (alertBox) {
      alertBox.style.display = 'none';
    }
  },

  /**
   * Traduce errores técnicos comunes de Supabase a mensajes comprensibles
   * @param {object} error
   * @returns {string}
   */
  formatErrorMessage(error) {
    if (!error) return 'Ocurrió un error inesperado.';

    const msg = error.message || '';

    if (msg.includes('Invalid login credentials')) {
      return 'Correo electrónico o contraseña incorrectos.';
    }
    if (msg.includes('Email not confirmed')) {
      return 'Debes confirmar tu correo electrónico antes de ingresar. Revisa tu bandeja de entrada.';
    }
    if (msg.includes('User already registered')) {
      return 'Ya existe una cuenta con este correo. Por favor, selecciona "Iniciar Sesión".';
    }
    if (msg.includes('Password should be at least 6 characters')) {
      return 'La contraseña debe tener al menos 6 caracteres.';
    }
    if (msg.includes('Unable to validate email address: invalid format')) {
      return 'El formato de correo electrónico no es válido.';
    }
    if (msg.includes('rate limit') || msg.includes('over_email_send_rate_limit')) {
      return 'Has superado el límite de intentos. Espera unos minutos antes de volver a intentar.';
    }

    return msg || 'Error de autenticación. Intenta nuevamente.';
  },

  /**
   * Verifica si las credenciales de Supabase aún contienen los placeholders
   * @returns {boolean}
   */
  isPlaceholderConfig() {
    const url = window.SUPABASE_URL || '';
    const key = window.SUPABASE_ANON_KEY || '';
    return (
      url.includes('TU-PROYECTO') ||
      key.includes('TU-ANON-KEY-AQUI') ||
      !url.startsWith('https://')
    );
  }
};

// Exponer globalmente
window.authManager = authManager;

// Inicialización automática tras cargar el DOM
document.addEventListener('DOMContentLoaded', () => {
  authManager.init();
});
