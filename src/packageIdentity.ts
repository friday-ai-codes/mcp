import packageInfo from '../package.json' with { type: 'json' }

export const SERVER_VERSION = packageInfo.version
export const PINNED_PACKAGE = `${packageInfo.name}@${SERVER_VERSION}`
