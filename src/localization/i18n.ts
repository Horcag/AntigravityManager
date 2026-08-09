import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import vi from './vi';
import tr from './tr';
import en from './en';
import zhCn from './zh-CN';
import ru from './ru';
import fr from './fr';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'lang',
    },
    supportedLngs: ['en', 'zh-CN', 'ru', 'vi', 'tr', 'fr'],
    load: 'currentOnly', // Only load the exact language code, not variants
    /**
     * React escapes everything it renders, so i18next escaping again turns any
     * interpolated value containing HTML-special characters into entities the
     * user actually sees. It showed up as `Last seen 8&#x2F;9&#x2F;2026` on the
     * proxy tab, and would do the same to an imported file name carrying `&`.
     */
    interpolation: { escapeValue: false },
    resources: {
      en: {
        translation: en,
      },
      vi: {
        translation: vi,
      },
      tr: {
        translation: tr,
      },
      'zh-CN': {
        translation: zhCn,
      },
      ru: {
        translation: ru,
      },
      fr: {
        translation: fr,
      },
    },
  });

export default i18n;
