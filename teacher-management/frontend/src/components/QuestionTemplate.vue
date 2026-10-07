<template>
  <v-card>
    <v-card-title class="my-1">
      <slot name="title">
        <h3 class="text-headline-small my-2">{{ assignment.title }}</h3>
      </slot>
    </v-card-title>
    <v-card-subtitle>
      {{ t("assignment.totalScore", { score: assignment.score }) }}
    </v-card-subtitle>
    <v-card-text class="text-body-1">
      <p class="mb-4" style="white-space: pre-wrap">
        {{ assignment.description }}
      </p>

      <v-container>
        <p>{{ t("assignment.allowedExtensions") }}: {{ assignment.allowed_extension }}</p>
        <v-file-input
          :accept="acceptedExtensions"
          class="my-2"
          clearable
          :label="t('button.uploadFile')"
          :hint="disable ? `` : t('upload.hint')"
          persistent-hint
          v-model="selectedFile"
          @update:model-value="$emit('update:selected-file', selectedFile)"
          :disabled="viewResult || disable"
        />
        <v-row>
          <v-btn
            variant="text"
            v-if="disable && !!lastSubmission?.file"
            @click="downloadFile(lastSubmission?.file!)"
            prepend-icon="mdi-download"
            :text="t('button.download')"
            :loading="downloading"
          />

        </v-row>
      </v-container>

      <div v-if="viewResult">
        <v-divider class="my-4" />
        <h4 class="text-title-large mb-1">{{ t("submission.yourScore") }}</h4>
        <p v-if="isTeacher" style="font-size: 1.25em">…… / {{ assignment.score }}</p>
        <p
          v-else-if="lastSubmission?.status === 1 && lastSubmission.score != null"
          :class="[
            lastSubmission.score !== assignment.score ? 'text-warning' : '',
            'ml-4',
            'mb-2',
          ]"
          style="font-size: 1.25em"
        >
          {{ lastSubmission.score }} / {{ assignment.score }}
        </p>
        <!-- 未批改或未公开的分数显示为“无” -->
        <p v-else>{{ t("submission.noScore") }}</p>
        <v-divider class="my-4" />
      </div>
    </v-card-text>
    <slot name="action" />
  </v-card>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { useAppStore } from "@/stores/app";
import { Assignment, Submission } from "@/api/course";
import { ApiDownloadFile, S3DownloadFile } from "@/api/file";
import { getExtension, saveBlobAsFile } from "@/utils/download";
import { parseExtensions } from "@/utils/assignments";
import { useI18n } from "vue-i18n";
import { partial as filesizePartial } from "filesize";
import { AxiosProgressEvent } from "axios";

// // Markdown: mavonEditor
// import { mavonEditor } from "mavon-editor";
// import "mavon-editor/dist/css/index.css";

interface Props {
  assignment: Assignment;
  disable: boolean;
  lastSubmission: Submission | null;
  viewResult?: boolean;
}
const props = withDefaults(defineProps<Props>(), {
  viewResult: false,
});
const acceptedExtensions = computed(() =>
  parseExtensions(props.assignment.allowed_extension)
    .map((extension) => `.${extension}`)
    .join(",") || undefined,
);

const store = useAppStore();
const { sendSnack } = store;
const fsize = filesizePartial({ base: 2, standard: "iec", precision: 3 });

const selectedFile = ref(null);
// const src = ref({});
// const numPages = ref(undefined);
const downloading = ref(false);

// 不直接用 presigned.url 作 href，因为跨源的情况下 download 属性对浏览器无效，
// 不能指定文件名。

async function downloadFile(fileIdent: string) {
  sendSnack(t("downloading"), "info", -1);
  store.snack.progress.show = true;
  store.snack.closable = false;
  downloading.value = true;

  function formatProgress(rate?: number, estimated?: number): string {
    if (!rate || !estimated) {
      return "";
    }
    const estimatedSec = estimated % 60;
    const estimatedMin = Math.floor(estimated / 60);
    return t("submission.downloadProgress", {
      rate: fsize(rate),
      estimatedSec: estimatedSec.toPrecision(2),
      // 这个参数须命名为 n，才能利用 vue-i18n 默认的复数（零）处理
      n: estimatedMin,
    });
  }

  try {
    const presigned = (await ApiDownloadFile(fileIdent)).data;

    store.snack.progress.indeterminate = false;
    const blob = (
      await S3DownloadFile(presigned.url, (e: AxiosProgressEvent) => {
        if (downloading.value) {
          store.snack.progress.value = e.progress! * 100;
          store.snack.message =
            t("downloading") + "\n" + formatProgress(e.rate, e.estimated);
        }
      })
    ).data;

    store.snack.progress.indeterminate = true;

    const extension = getExtension(presigned.original_file_name);
    const suffix = extension ? "." + extension : "";
    saveBlobAsFile(
      blob,
      isTeacher.value
        ? `${props.lastSubmission?.user.username}_${props.lastSubmission?.user.real_name}_${props.assignment.title}${suffix}`
        : `${props.assignment.title}_${props.lastSubmission?.submit_time}${suffix}`,
    );
    store.snack.progress.show = false;
    sendSnack(t("download.success"), "success", 5000);
  } catch {
    sendSnack(t("download.fail"), "warning");
  } finally {
    downloading.value = false;
  }
}

const { isTeacher } = storeToRefs(useAppStore());
const { t } = useI18n();
</script>

<i18n lang="yaml">
zh:
  assignment:
    totalScore: "总分：{score}"
    allowedExtensions: 允许的文件后缀
  button:
    uploadFile: 上传文件
    download: 点击下载
  upload:
    hint: 点击浏览或将文件拖放到此处
  submission:
    yourScore: 您的得分
    noScore: 暂无
    downloadProgress: "{rate}/s，预计还需 {estimatedSec} 秒 | {rate}/s，预计还需 {n} 分 {estimatedSec} 秒 | {rate}/s，预计还需 {n} 分 {estimatedSec} 秒"
  downloading: 下载中……
  download:
    success: 下载完成
    fail: 下载失败
en:
  assignment:
    totalScore: "Total Score: {score}"
    allowedExtensions: Allowed extensions
  button:
    uploadFile: Upload File
    download: Download
  upload:
    hint: Click to browse or drag file here
  submission:
    yourScore: Your Score
    noScore: Not graded
    downloadProgress: "{rate}/s, {estimatedSec} sec remaining | {rate}/s, {n} min {estimatedSec} sec remaining | {rate}/s, {n} min {estimatedSec} sec remaining"
  downloading: Downloading……
  download:
    success: Download completed
    fail: Download failed
</i18n>
