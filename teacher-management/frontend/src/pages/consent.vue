<template>
  <v-container class="d-flex flex-column fill-height">
    <div style="flex: 4 0 0em; align-content: flex-end">
      <v-scale-transition>
        <v-alert
          v-if="errorMsg"
          class="my-8"
          type="warning"
          closable
          border="start"
          @click:close="errorMsg = ''"
        >
          {{ errorMsg }}
        </v-alert>
      </v-scale-transition>
    </div>

    <div
      v-if="loading"
      class="d-flex justify-center align-center w-100 mx-auto"
      style="max-width: 29em; min-height: 12em"
    >
      <v-progress-circular indeterminate color="primary" size="64" />
    </div>

    <v-card
      v-else-if="info"
      :title="t('title')"
      color="primary"
      class="w-100 mx-auto"
      max-width="29em"
      elevation="6"
    >
      <template v-slot:prepend>
        <v-avatar
          class="pa-1 my-1"
          image="/favicon.ico"
          color="white"
          size="small"
          rounded
        />
      </template>

      <v-card-text class="bg-surface py-4">
        <p class="text-body-1 mb-1 font-weight-medium">
          {{ t("subtitle", { clientName: info.client_name }) }}
        </p>
        <p class="text-caption text-medium-emphasis mb-4">
          {{ t("loggedInAs", { username: info.username }) }}
        </p>

        <v-divider class="mb-3" />

        <p class="text-subtitle-2 mb-2">{{ t("requestedScopes") }}</p>
        <v-list density="compact" class="bg-transparent py-0 scope-list">
          <v-list-item
            v-for="s in info.scopes"
            :key="s"
            :title="scopeName(s)"
            prepend-icon="mdi-shield-check-outline"
            class="px-0"
          />
        </v-list>

        <form action="/management-api/oauth/authorize" method="post" class="mt-6">
          <input type="hidden" name="client_id" :value="info.client_id" />
          <input
            type="hidden"
            name="redirect_uri"
            :value="info.redirect_uri"
          />
          <input type="hidden" name="response_type" value="code" />
          <input type="hidden" name="scope" :value="info.scope" />
          <input
            v-if="info.state != null"
            type="hidden"
            name="state"
            :value="info.state"
          />
          <!-- PKCE 对 confidential client 可选，后端返回时才随授权决策提交。 -->
          <input
            v-if="info.code_challenge != null"
            type="hidden"
            name="code_challenge"
            :value="info.code_challenge"
          />
          <input
            v-if="info.code_challenge_method != null"
            type="hidden"
            name="code_challenge_method"
            :value="info.code_challenge_method"
          />
          <input type="hidden" name="csrf_token" :value="info.csrf_token" />

          <v-row dense>
            <v-col>
              <v-btn
                type="submit"
                name="decision"
                value="deny"
                block
                variant="text"
              >
                {{ t("deny") }}
              </v-btn>
            </v-col>
            <v-col>
              <v-btn
                type="submit"
                name="decision"
                value="approve"
                block
                color="primary"
                variant="tonal"
              >
                {{ t("approve") }}
              </v-btn>
            </v-col>
          </v-row>
        </form>
      </v-card-text>
    </v-card>

    <div
      v-else
      class="w-100 mx-auto"
      style="max-width: 29em; min-height: 12em"
    />

    <div style="flex: 5 0 0em"></div>
  </v-container>
</template>

<script lang="ts" setup>
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { instance as api } from "@/api/axiosInstance";
import { getGeneralErrorMsg } from "@/utils/error";

const route = useRoute();
const router = useRouter();
const { t, te } = useI18n();

interface AuthorizeInfo {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  scope: string;
  scopes: string[];
  state: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  csrf_token: string;
  username: string;
}

const loading = ref(true);
const info = ref<AuthorizeInfo | null>(null);
const errorMsg = ref("");

// OAuth 基础授权参数；PKCE 由后端按 client 类型决定是否需要。
const requiredParams = [
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
];

function scopeName(scope: string): string {
  const key = `scopes.${scope}`;
  if (te(key)) return t(key);
  return scope;
}

onMounted(async () => {
  const missing = requiredParams.filter((p) => !route.query[p]);
  if (missing.length > 0) {
    loading.value = false;
    errorMsg.value = t("error.missingParams");
    return;
  }

  try {
    // 由后端统一校验 client_id、redirect_uri 和 scope，并返回展示用授权信息。
    const response = await api.get<AuthorizeInfo>("/api/oauth/authorize", {
      params: {
        client_id: route.query.client_id,
        redirect_uri: route.query.redirect_uri,
        response_type: route.query.response_type,
        scope: route.query.scope,
        state: route.query.state,
        code_challenge: route.query.code_challenge,
        code_challenge_method: route.query.code_challenge_method,
      },
    });
    info.value = response.data;
  } catch (error: any) {
    if (error?.response?.status === 401) {
      // 路由守卫可能因前端内存态跳过校验；授权接口 401 时兜底回登录页。
      await router.replace({
        name: "login",
        query: { next: route.fullPath },
      });
      return;
    }
    errorMsg.value = t("error.loadFailed") + getGeneralErrorMsg(error);
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.scope-list :deep(.v-list-item) {
  --v-list-prepend-gap: 12px;
}
</style>

<route lang="yaml">
name: consent
meta:
  layout: hill
  title: 授权访问
  titleEn: Authorize Access
</route>

<i18n lang="yaml">
zh:
  title: 授权访问
  subtitle: "{clientName} 请求访问你的帐号"
  loggedInAs: "你当前以 {username} 登录"
  requestedScopes: "此应用请求以下权限"
  approve: 同意授权
  deny: 拒绝
  error:
    missingParams: 授权请求缺少必要参数，无法继续。
    loadFailed: "加载授权信息失败："
  scopes:
    "courses:read": 读取你的课程信息
    "assignments:read": 读取你的作业信息
    "submissions:read": 读取你的提交信息
    "grades:read": 读取你的成绩信息
    "files:read": 读取你的文件信息
en:
  title: Authorize Access
  subtitle: "{clientName} requests access to your account"
  loggedInAs: "You are signed in as {username}"
  requestedScopes: "This application requests the following permissions"
  approve: Authorize
  deny: Deny
  error:
    missingParams: The authorization request is missing required parameters.
    loadFailed: "Failed to load authorization info: "
  scopes:
    "courses:read": Read your courses
    "assignments:read": Read your assignments
    "submissions:read": Read your submissions
    "grades:read": Read your grades
    "files:read": Read your files
</i18n>
