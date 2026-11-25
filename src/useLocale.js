import { useSyncExternalStore } from 'react';
import { getLocale } from './i18n.js';
const subscribe = callback => {
  window.addEventListener('adx:locale', callback);
  return () => window.removeEventListener('adx:locale', callback);
};
export default function useLocale() {
  return useSyncExternalStore(subscribe, getLocale, () => 'zh');
}
