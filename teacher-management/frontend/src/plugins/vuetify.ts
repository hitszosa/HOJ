/**
 * plugins/vuetify.ts
 *
 * Framework documentation: https://vuetifyjs.com`
 */

// Styles
import "@mdi/font/css/materialdesignicons.css";
import "vuetify/styles";

// Composables
import { createVuetify } from "vuetify";
import { VTimePicker } from "vuetify/components";
import { zhHans } from "vuetify/locale";

// https://vuetifyjs.com/en/introduction/why-vuetify/#feature-guides
export default createVuetify({
  display: {
    mobileBreakpoint: "sm",
  },
  components: {
    VTimePicker,
  },
  locale: {
    locale: "zhHans",
    messages: { zhHans },
  },
  theme: {
    defaultTheme: "light",
    themes: {
      light: {
        colors: {
          "surface-alt": "#fafafa",
        },
      },
      dark: {
        colors: {
          "surface-alt": "#1a1a1a",
          "on-surface": "#eeeeee",
        },
      },
    },
  },
});
