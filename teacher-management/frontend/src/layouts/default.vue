<template>
  <v-app-bar v-if="!route.query.embed" height="104" :elevation="0" class="hoj-unified-toolbar">
    <header class="hoj-app-header">
      <div class="hoj-app-top">
        <a class="hoj-app-brand" href="/management/home">{{ text('HOJ 教学平台', 'HOJ Teaching Platform') }}</a>
        <div class="hoj-app-account">
          <span v-if="identity" class="hoj-app-role">{{ platformRole(identity,locale) }}</span>
          <v-btn variant="text" :href="user.id ? undefined : '/management/login'" class="text-none">
            {{ user.id ? user.real_name : text('登录', 'Sign in') }}
            <v-icon v-if="user.id" end>mdi-chevron-down</v-icon>
            <v-menu v-if="user.id" activator="parent" location="bottom end">
              <v-list>
                <v-list-item :to="{ name: 'change-user-info' }" prepend-icon="mdi-account-circle" :title="text('我的账号','My account')" />
                <v-list-item to="/preferences" prepend-icon="mdi-tune" :title="text('偏好设置','Preferences')" />
                <v-list-item to="/docs" prepend-icon="mdi-book-open-outline" :title="text('使用帮助','Help')" />
                <v-list-item prepend-icon="mdi-logout" :title="text('退出登录','Sign out')" @click="confirmLogout" />
              </v-list>
            </v-menu>
          </v-btn>
        </div>
      </div>
      <nav class="hoj-app-nav" :aria-label="text('平台导航','Platform navigation')">
        <a v-for="item in navigation" :key="item.id" :href="item.href" class="hoj-app-nav-link" :aria-current="platformSection('/management'+route.path) === item.id ? 'page' : undefined">{{ locale === 'en' ? item.en : item.zh }}</a>
      </nav>
    </header>
  </v-app-bar>
  <v-main id="layout-main" v-if="showRouterView !== false">
    <slot name="main-wrapper">
      <router-view v-slot="{ Component, route }">
        <transition mode="out-in" :name="pageTransitionName">
          <keep-alive :max="6">
            <component :is="Component" :key="route.path" />
          </keep-alive>
        </transition>
      </router-view>
    </slot>
  </v-main>

  <v-dialog
    v-if="announcement"
    v-model="showAnnouncement"
    :persistent="announcement.display === 'dialogPersistent'"
    max-width="600"
    @keydown.esc.stop.prevent="closeAnnouncement"
  >
    <v-card>
      <v-card-title class="my-2">
        {{ announcement.title[announcementLanguage] }}
      </v-card-title>
      <v-card-text>
        <span
          v-if="announcement.content[announcementLanguage]"
          style="white-space: pre-wrap"
        >
          {{ announcement.content[announcementLanguage] }}
        </span>
      </v-card-text>
      <v-card-actions>
        <v-checkbox
          :label="t('nav.doNotShowAgain')"
          v-model="doNotShowAnnouncementAgain"
          hide-details
        />

        <v-spacer />
        <v-btn color="primary" @click="closeAnnouncement">
          {{ t("dialog.ok") }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts" setup>
import { useAppStore } from "@/stores/app";
import { platformNavigation, platformRole, platformSection, type PlatformIdentity } from "../../../../frontend/src/lib/platform-navigation";
import { ApiLogout, UserInfo } from "@/api/user";
import { storeToRefs } from "pinia";
import { useConfirm } from "@/utils/confirm";
import { usePreferenceStore } from "@/stores/theme";
import { useI18n } from "vue-i18n";
import { ApiGetAnnouncement, SiteAnnouncement } from "@/api/manage";

const route = useRoute();
const store = useAppStore();
const { user, pageTransitionName } = storeToRefs(store);
const { updateUser, sendSnack } = store;
const createConfirm = useConfirm();
const preferences = usePreferenceStore();
const { t, locale } = useI18n({ useScope: "global" });

withDefaults(defineProps<{ stageTitle?: string; showRouterView?: boolean; initialOpenedNavGroups?: string[] }>(), { showRouterView:true });
const text = (zh:string,en:string) => locale.value === 'en' ? en : zh;
const identity = ref<PlatformIdentity | null>(null);
const navigation = computed(() => platformNavigation(identity.value));
let identityRequest = 0;
watch(() => user.value.username, async username => {
  const current = ++identityRequest;
  identity.value = null;
  if (!username) return;
  try {
    const response = await fetch('/api/me', { credentials:'same-origin' });
    if (!response.ok) return;
    const body = await response.json();
    if (current === identityRequest && body.data?.user === user.value.username) identity.value = body.data;
  } catch { /* Fail closed until identity can be confirmed. */ }
}, { immediate:true });
onUnmounted(() => { ++identityRequest; });

/// 登出
async function logout() {
  await ApiLogout();
  updateUser({} as UserInfo);
  const response = await fetch("/api/session", { method: "DELETE" });
  if (!response.ok) { sendSnack(t("error.responseGeneral"), "error"); return; }
  window.location.assign("/management/login");
  sendSnack(t("nav.loggedOut"));
}

async function confirmLogout() {
  const confirmed = await createConfirm({
    title: t("nav.confirmLogout.title"),
    content: t("nav.confirmLogout.content"),
    confirmationText: t("nav.confirmLogout.yes"),
    confirmationButtonProps: { color: "error" },
  });
  if (confirmed) logout();
}

const announcementLanguage = computed(() => (locale.value === "en" ? "en" : "zh"));

const announcement = ref<
  | null
  | (Omit<SiteAnnouncement, "publish_date" | "effective_until"> & {
      publish_date: Date;
      effective_until: Date;
    })
>(null);
const doNotShowAnnouncementAgain = ref(true);
const showAnnouncement = ref(false);

function closeAnnouncement() {
  showAnnouncement.value = false;
  if (doNotShowAnnouncementAgain.value) {
    preferences.dismissAnnouncementBefore = new Date().toISOString();
  }
}

onMounted(async () => {
  if (preferences.justLoggedIn) {
    preferences.justLoggedIn = false;
    const { data } = await ApiGetAnnouncement();

    if (data)
      announcement.value = {
        ...data,
        publish_date: new Date(data.publish_date),
        effective_until: new Date(data.effective_until),
      };
    const now = new Date();

    if (
      announcement.value &&
      announcement.value.enable &&
      new Date(preferences.dismissAnnouncementBefore) < announcement.value.publish_date &&
      now < announcement.value.effective_until
    ) {
      // 显示公告

      if (announcement.value.display === "snack") {
        sendSnack(announcement.value.content[announcementLanguage.value], "info", -1);
      } else {
        showAnnouncement.value = true;
      }
    }
  }

});
</script>

<style>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease-out;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.scroll-x-enter-active,
.scroll-x-leave-active,
.scroll-x-reverse-enter-active,
.scroll-x-reverse-leave-active {
  transition: 0.2s ease-out;
}

.scroll-x-enter-from,
.scroll-x-reverse-leave-to {
  transform: translateX(-1em);
  opacity: 0;
}
.scroll-x-leave-to,
.scroll-x-reverse-enter-from {
  transform: translateX(1em);
  opacity: 0;
}
</style>
