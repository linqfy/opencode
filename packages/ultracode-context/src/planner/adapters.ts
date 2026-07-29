export const getFeatureValue_CACHED_MAY_BE_STALE = (featureKey: string, defaultValue: any): any => {
  return defaultValue
}

export const logEvent = (eventName: string, data: any): void => {}

export const logError = (error: Error): void => {
  console.error('[Context Planner Error]', error)
}

export const logForDebugging = (message: string, options?: any): void => {}
