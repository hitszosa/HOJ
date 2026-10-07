<template>
  <v-container class="d-flex flex-column fill-height">
    <div style="flex: 4 0 0em; align-content: flex-end">
      <v-scale-transition>
        <v-alert
          class="my-8"
          :type="alertType"
          closable
          border="start"
          v-model="alertVisible"
        >
          {{ alertMsg }}
        </v-alert>
      </v-scale-transition>
    </div>
    <v-card
      :title="t('platformTitle')"
      color="primary"
      class="w-100 mx-auto"
      max-width="29em"
      elevation="6"
    >
      <template v-slot:prepend>
        <v-avatar
          class="pa-1 my-1"
          :image="appIcon"
          color="white"
          size="small"
          rounded
        />
      </template>

      <v-card-text class="bg-surface py-4">
        <v-form class="px-2" ref="loginForm">
          <v-text-field
            :label="$t('username')"
            v-model="username"
            :rules="[(v: string) => !!v || t('usernameRequired')]"
            variant="underlined"
            prepend-icon="mdi-account"
            type="text"
            autocomplete="username"
          />

          <v-text-field
            :label="$t('password')"
            v-model="password"
            variant="underlined"
            :rules="[(v: string) => !!v || t('passwordRequired')]"
            :type="showPassword ? 'text' : 'password'"
            id="password"
            autocomplete="current-password"
            prepend-icon="mdi-lock"
            :append-icon="showPassword ? 'mdi-eye' : 'mdi-eye-off'"
            @click:append="showPassword = !showPassword"
            @keyup.enter="login"
          />
        </v-form>
        <v-card-actions class="px-4 mt-4">
          <v-btn
            @click="login"
            block
            color="primary"
            variant="tonal"
            size="large"
            :loading="loginPending"
          >
            {{ $t("nav.login") }}
          </v-btn>
        </v-card-actions>

        <v-progress-linear
          :active="loginPending"
          :indeterminate="loginPending"
          absolute
          location="bottom"
        />
      </v-card-text>
    </v-card>
    <div style="flex: 5 0 0em"></div>
  </v-container>
</template>

<script lang="ts" setup>
import { ref } from "vue";
import type { VForm } from "vuetify/lib/components/index.mjs";
import { ApiClaimPasswordReminder, ApiGetCurrentUser, ApiLogin } from "@/api/user";
import { platformLoginReturn } from "../../../../frontend/src/lib/platform-navigation";
import { useRoute } from "vue-router";
import { useAppStore } from "@/stores/app";
import { usePreferenceStore } from "@/stores/theme";
import { useI18n } from "vue-i18n";
import { useConfirm } from "@/utils/confirm";

const route = useRoute();
const { t } = useI18n();
const preferences = usePreferenceStore();
const { updateUser } = useAppStore();
const createConfirm = useConfirm();

// 警告框
const alertType: Ref<"success" | "warning"> = ref("success");
const alertVisible = ref(false);
const alertMsg = ref("");
const loginPending = ref(false);

function showAlert(type: "warning" | "success", msg: string) {
  alertVisible.value = true;
  alertMsg.value = msg;
  alertType.value = type;
}

const appIcon = `${import.meta.env.BASE_URL}favicon.ico`;
// 登录表单
const loginForm = ref<VForm | null>(null);
const username = ref("");
const password = ref("");
const showPassword = ref(false);

async function login() {
  if (!(await loginForm.value?.validate())?.valid) {
    return;
  }
  alertVisible.value = false;
  loginPending.value = true;
  let changePassword = false;
  try {
    const loginResponse = await fetch("/api/account/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.value.trim(), password: password.value }),
    });
    const result = await loginResponse.json();
    let profile;
    if (loginResponse.ok) {
      profile = (await ApiGetCurrentUser()).data;
    } else {
      if (![401, 429].includes(loginResponse.status)) throw new Error(result.message || t("fail.login"));
      // Independent management accounts use the same form. Imported HOJ accounts
      // are rejected by this API, so their authoritative password cannot be bypassed.
      try {
        profile = (await ApiLogin(username.value.trim(), password.value)).data;
      } catch {
        throw new Error(result.message || t("fail.login"));
      }
    }
    updateUser(profile);
    password.value = "";
    const reminder = (await ApiClaimPasswordReminder()).data;
    if (reminder.show) {
      changePassword = await createConfirm({
        title: t("passwordReminder.title"),
        content: t("passwordReminder.content"),
        confirmationText: t("passwordReminder.change"),
        cancellationText: t("passwordReminder.later"),
        cardProps: { prependIcon: "mdi-shield-account" },
      });
    }
  } catch (error: any) {
    loginPending.value = false;
    const errorMsg = error?.message || t("fail.login");

    showAlert("warning", t("fail.login") + errorMsg);
    return;
  }

  preferences.justLoggedIn = true;

  loginPending.value = false;
  showAlert("success", t("success.login"));
  window.location.replace(changePassword ? "/management/change_info" : platformLoginReturn(route.query.next));
}
</script>

<route lang="yaml">
name: login
meta:
  layout: hill
  no_login: true
  title: 登录
  titleEn: Login
</route>

<i18n lang="yaml">
zh:
  platformTitle: HOJ 教学平台
  usernameRequired: 请输入用户名
  passwordRequired: 请输入密码
  passwordReminder:
    title: 建议修改初始密码
    content: 为保护账号，请将初始密码修改为只有你知道的密码。此提醒只显示一次，稍后也可以从右上角“我的账号”修改。
    change: 去修改密码
    later: 稍后再改
  fail:
    login: 登录失败：
  success:
    login: 登录成功！即将跳转到首页。
en:
  platformTitle: HOJ Teaching Management
  usernameRequired: Username is required
  passwordRequired: Password is required
  passwordReminder:
    title: Change your initial password
    content: For your account security, choose a password that only you know. This reminder appears once. You can also change it later from My account in the top-right menu.
    change: Change password
    later: Later
  fail:
    login: "Login failed: "
  success:
    login: Login success. You'll be redirected soon.

</i18n>
