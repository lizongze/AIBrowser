'use strict';
// GUI 渲染进程 ↔ 主进程桥接（contextBridge）。契约见 docs/CONTRACT.md 第 6 节。
const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, payload) {
  return ipcRenderer.invoke(`pvs:${channel}`, payload);
}

const api = {
  runtime: () => invoke('runtime'),

  files: {
    openFolder: (payload) => invoke('files:openFolder', payload),
    roots: () => invoke('files:roots'),
    setRoot: (dir) => invoke('files:setRoot', { dir }),
    tree: (dir) => invoke('files:tree', { dir }),
    read: (path) => invoke('files:read', { path }),
    write: (path, text) => invoke('files:write', { path, text }),
    stat: (path) => invoke('files:stat', { path }),
  },

  sessions: {
    open: (payload) => invoke('sessions:open', payload),
    openCode: (payload) => invoke('sessions:openCode', payload),
    list: () => invoke('sessions:list'),
    close: (sessionId) => invoke('sessions:close', { sessionId }),
    focus: (sessionId) => invoke('sessions:focus', { sessionId }),
    reload: (sessionId, hard) => invoke('sessions:reload', { sessionId, hard }),
    navigate: (sessionId, target) => invoke('sessions:navigate', { sessionId, ...target }),
    back: (sessionId) => invoke('sessions:back', { sessionId }),
    forward: (sessionId) => invoke('sessions:forward', { sessionId }),
    zoom: (sessionId, factor) => invoke('sessions:zoom', { sessionId, factor }),
    screenshot: (payload) => invoke('sessions:screenshot', payload),
    console: (payload) => invoke('sessions:console', payload),
    network: (payload) => invoke('sessions:network', payload),
    eval: (payload) => invoke('sessions:eval', payload),
  },

  ui: {
    ready: () => invoke('ui:ready'),
    toggleSidebar: (visible) => invoke('ui:sidebar', { visible }),
    zoom: (factor) => invoke('ui:zoom', typeof factor === 'number' ? { factor } : {}),
    zoomBy: (delta) => invoke('ui:zoom', { delta }),
    layout: (payload) => invoke('ui:layout', payload),
    activeView: (sessionId) => invoke('ui:activeView', { sessionId }),
    openExternal: (url) => invoke('ui:openExternal', { url }),
    setView: (view, sessionId) => invoke('ui:setView', { view, sessionId }),
    setTheme: (theme) => invoke('ui:setTheme', { theme }),
    info: () => invoke('ui:info'),
  },

  on: (channel, callback) => {
    const listener = (_event, message) => {
      if (!message || message.channel !== channel) return;
      callback(message.payload);
    };
    ipcRenderer.on('pvs:event', listener);
    return () => ipcRenderer.removeListener('pvs:event', listener);
  },
};

contextBridge.exposeInMainWorld('api', api);
