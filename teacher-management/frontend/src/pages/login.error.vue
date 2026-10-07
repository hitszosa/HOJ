<template>
  <v-container class="d-flex flex-column fill-height">
    <div style="flex: 3 0 0em"></div>
    <v-card
      :title="t('title')"
      color="primary"
      class="w-100 mx-auto"
      max-width="42em"
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
        <v-alert class="mb-4" type="error" variant="tonal" border="start">
          {{ t("hint") }}
        </v-alert>

        <p class="text-medium-emphasis mb-2">{{ t("rawError") }}</p>
        <div class="login-error-message" v-if="errorMessage.length > 0">
          <pre>{{ errorMessage }}</pre>
        </div>
        <p class="text-medium-emphasis mb-2" v-else>{{ t("emptyError") }}</p>
        

        <v-card-actions class="px-0 pt-6">
          <v-btn
            to="/login"
            color="primary"
            variant="tonal"
            prepend-icon="mdi-arrow-left"
          >
            {{ t("backToLogin") }}
          </v-btn>
        </v-card-actions>
      </v-card-text>
    </v-card>
    <div style="flex: 4 0 0em"></div>
  </v-container>
</template>

<script lang="ts" setup>
import { useI18n } from "vue-i18n";

const route = useRoute();
const { t } = useI18n();

const errorMessage = computed(() => {
  const { error } = route.query;

  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  if (Array.isArray(error)) {
    const messages = error.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    if (messages.length > 0) {
      return messages.join("\n");
    }
  }

  return "";
});
</script>

<style scoped>
.login-error-message {
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 12px;
  background-color: rgba(var(--v-theme-on-surface), 0.04);
  max-height: min(40vh, 24rem);
  overflow: auto;
}

.login-error-message pre {
  margin: 0;
  padding: 1rem;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 0.95rem;
  line-height: 1.5;
}
</style>

<route lang="yaml">
name: login-error
meta:
  layout: hill
  no_login: true
  title: 登录失败
  titleEn: Login Failed
</route>

<i18n lang="yaml">
zh:
  title: 登录失败
  hint: "统一身份认证登录未能完成。可能原因有：①你的用户身份尚不允许登录 Grader 2 平台，请携带以下信息联系教师或管理员。②统一身份认证系统出了点问题或网络繁忙，请稍后再试。"
  rawError: 详细信息
  backToLogin: 返回
  emptyError: 未提供错误详情。
en:
  title: Login Failed
  hint: "Unified identity authentication failed and you're not logged in. Possible reasons: ① Your identity type is not allowed to login to Grader 2, please contact your teacher or administrator with the following detail message. ② Network busy or there is a problem with the unified identity system now. Please try again later."
  rawError: Details
  backToLogin: Go Back 
  emptyError: No error details were provided.
</i18n>
