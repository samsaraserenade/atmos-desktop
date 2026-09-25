import { matrixState, save } from './state.js';
import { createPreference } from './preference-store.js';



const notificationSound = createPreference(matrixState, 'notificationSound', value => value !== false, save);
export const getNotificationSound = notificationSound.get;
export const setNotificationSound = notificationSound.set;
export const onNotificationSoundChanged = notificationSound.subscribe;
