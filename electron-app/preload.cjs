/**
 * AVC-Anime preload — безопасный мост между Next.js UI и главным процессом.
 *
 * ПРИНЦИПЫ (спецификация, секция 15):
 *   - наружу выставлены ТОЛЬКО методы высокого уровня, возвращающие
 *     НЕ-секретные данные (снимки аккаунта, избранное, отчёты диагностики);
 *   - никаких ipcRenderer, webContents, cookies наружу;
 *   - cookie/пароли/токены через мост не проходят никогда.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('avcElectron', {
  platform: 'electron',

  /** Состояние аккаунта (не-секретный снимок) */
  getAccountState: (refresh) => ipcRenderer.invoke('avc:auth:getState', { refresh: !!refresh }),

  /** Открыть окно входа на реальный сайт; резолв после закрытия окна */
  openLoginWindow: () => ipcRenderer.invoke('avc:auth:open-login'),

  /** Принудительная проверка аутентификации через сайт */
  verifyAuthentication: () => ipcRenderer.invoke('avc:auth:verify'),

  /** Выход ЧЕРЕЗ САЙТ + подтверждение состояния */
  logout: () => ipcRenderer.invoke('avc:auth:logout'),

  /** Избранное с сайта (данные сессии main-процесса, без секретов) */
  getFavorites: (refresh) => ipcRenderer.invoke('avc:auth:favorites', { refresh: !!refresh }),

  /** Сброс постоянной сессии (backup + подтверждение в main) */
  resetYummySession: () => ipcRenderer.invoke('avc:auth:reset-session', { confirmed: true }),

  /** Диагностический selftest (безопасный отчёт) */
  runAuthSelfTest: () => ipcRenderer.invoke('avc:auth:selftest'),

  /** Подписка на изменения состояния аккаунта (вход/выход/истечение) */
  onAccountChanged: (cb) => {
    const handler = (_event, snap) => cb(snap)
    ipcRenderer.on('avc:account-changed', handler)
    return () => ipcRenderer.removeListener('avc:account-changed', handler)
  },

  /** Подписка на статусы входа (капча/ошибка/успех) для toast-сообщений */
  onAuthStatus: (cb) => {
    const handler = (_event, msg) => cb(msg)
    ipcRenderer.on('avc:auth-status', handler)
    return () => ipcRenderer.removeListener('avc:auth-status', handler)
  },
})
