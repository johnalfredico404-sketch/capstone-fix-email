window._APP_API_CONFIG = {
  firebase: {
    apiKey: 'AIzaSyBBuFx3jMH46BLrKY0Lx_7YmeCtg_na92g',
    authDomain: 'automated-school-violation-rec.firebaseapp.com',
    projectId: 'automated-school-violation-rec',
    storageBucket: 'automated-school-violation-rec.firebasestorage.app',
    messagingSenderId: '453921337704',
    appId: '1:453921337704:web:e53735c9f72c2f3222a6dd',
  },
  resend: {
    apiKey: 're_R6vb9bt_3eeAhQqgmun2da1UEBzLUy7',
    from: 'onboarding@resend.dev',
  },
  notifications: {
    resendEndpoint: 'https://api.resend.com/emails',
  },
};

// Keep the existing app pages compatible while notification utilities use the documented config name.
window.__APP_API_CONFIG__ = window._APP_API_CONFIG;
