// Dependency-free list of API methods (the sandboxed preload cannot load node_modules).
// Must stay in sync with HelixApi in ./api.ts and ipcSchemas in ./schemas.ts (enforced by a unit test).
export const API_SHAPE = {
  vault: [
    'status',
    'setup',
    'unlock',
    'unlockWithKeychain',
    'lock',
    'changePassword',
    'setKeychainUnlock',
    'reset'
  ],
  registries: [
    'list',
    'create',
    'update',
    'remove',
    'duplicate',
    'setDefault',
    'setPinned',
    'test',
    'exportConfigs',
    'importConfigs',
    'scanDockerLogins',
    'importDockerLogins'
  ],
  explorer: ['listRepositories', 'listTags', 'tagSummary', 'imageDetails', 'deleteTag', 'retag'],
  docker: ['status', 'storageInfo', 'listImages', 'removeImage'],
  transfers: ['list', 'start', 'cancel', 'retry', 'clearFinished'],
  settings: ['get', 'update', 'getPreferences', 'updatePreferences'],
  app: [
    'info',
    'chooseFile',
    'chooseSaveFile',
    'chooseDirectory',
    'showItemInFolder',
    'openPath',
    'openLogs',
    'openExternal',
    'cacheStats',
    'clearCache',
    'copyText'
  ]
} as const
