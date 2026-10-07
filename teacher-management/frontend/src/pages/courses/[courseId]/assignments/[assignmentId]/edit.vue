<template>
  <v-container>
    <TopNavigation
      :items="[
        { title: t('nav.coursesList'), to: { name: 'courses-list' } },
        {
          title: courseInfo.title,
          to: { name: 'assignments-list', params: { courseId } },
        },
        { title: t('nav.editAssignment', { title: assignment.title }) },
      ]"
    />

    <h2 class="my-4 text-headline-large font-weight-light">{{ t("editAssignment") }}</h2>
    <v-card>
      <v-card-title class="my-1" tag="h3">{{ t("questionInfo") }}</v-card-title>
      <v-card-text>
        <v-form v-model="valid" ref="form" validate-on="blur lazy">
          <v-textarea
            id="description-text"
            rows="9"
            :label="t('questionDescription')"
            variant="outlined"
            :rules="[(v: string) => !!v || t('descriptionRequired')]"
            v-model="question.description"
          />
          <v-row>
            <v-col cols="6" sm="4">
              <v-text-field
                type="number"
                :label="t('questionScore')"
                variant="underlined"
                prepend-icon="mdi-star-circle-outline"
                v-model="question.score"
              />
            </v-col>
            <v-col cols="6" sm="4">
              <v-combobox
                id="allowed_extension"
                :items="['txt', 'zip', 'ipynb']"
                :label="t('allowedExtensions')"
                :placeholder="t('allowedExtensionsPlaceholder')"
                persistent-placeholder
                variant="underlined"
                prepend-icon="mdi-file-percent-outline"
                :hint="t('allowedExtensionsHint')"
                persistent-hint
                v-model="question.allowed_extension"
                @update:focused="onExtensionFocus"
              />
            </v-col>
            <v-col cols="12" sm="4">
              <v-combobox
                :items="['10 MiB', '100 MiB', '1 GiB']"
                :label="t('fileSizeLimit')"
                variant="underlined"
                prepend-icon="mdi-sd"
                :hint="
                  fsize(question.max_file_size) === maxFileSize
                    ? question.max_file_size + ' B'
                    : Number.isNaN(maxFileSizeParsed)
                      ? undefined
                      : maxFileSizeParsed + ' B'
                "
                persistent-hint
                :rules="[
                  (s) => !!s || t('error.fileSizeEmpty'),
                  (s) => !Number.isNaN(parseFilesize(s)) || t('error.fileSize'),
                ]"
                v-model="maxFileSize"
              />
            </v-col>
          </v-row>
          <v-switch
            v-model="question.show_score"
            :label="t('showScore')"
            color="primary"
            hide-details
            class="mt-4"
          />
        </v-form>
      </v-card-text>
      <v-divider />
      <v-card-actions>
        <v-spacer />
        <v-btn
          v-if="!assignment.published"
          @click="submit()"
          :text="t('buttons.saveDraft')"
        />
        <v-btn
          variant="tonal"
          color="primary"
          @click="submit(true)"
          :text="assignment.published ? t('buttons.save') : t('buttons.saveAndPublish')"
        />
      </v-card-actions>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import {
  ApiTeacherPublishAssignment,
  ApiTeacherModifyAssignment,
  ApiGetCourseInfo,
  ApiGetAssignmentInfo,
} from "@/api/course";
import type { Assignment } from "@/api/course";
import type { VForm } from "vuetify/components";

import { onBeforeRouteLeave } from "vue-router";
import { useAppStore } from "@/stores/app";
import { useConfirm } from "@/utils/confirm";
import { storeToRefs } from "pinia";
import { setDocumentTitle } from "@/utils/page";
import { useI18n } from "vue-i18n";
import { partial as filesizePartial } from "filesize";
import { getGeneralErrorMsg } from "@/utils/error";
import { parseExtensions } from "@/utils/assignments";

const router = useRouter();
const { courseInfo } = storeToRefs(useAppStore());
const createConfirm = useConfirm();
const { sendSnack } = useAppStore();
const { t } = useI18n();
const fsize = filesizePartial({ base: 2, standard: "iec", precision: 3 });

const props = defineProps<{
  assignmentId: string;
  courseId: string;
}>();

// Component state

const form: Ref<VForm | null> = ref(null);
const valid = ref(false);
const maxFileSize = ref("10 MiB");
const maxFileSizeParsed = computed(() => parseFilesize(maxFileSize.value));

const assignment = ref({} as Assignment);

// Data

const DEFAULT_QUESTION = {
  description: "",
  allowed_extension: "",
  score: "100",
  show_score: false,
  max_file_size: 10485760,
};
const question = ref(structuredClone(DEFAULT_QUESTION));
const originalQuestion = ref(structuredClone(DEFAULT_QUESTION));

async function refreshState() {
  const resp = await ApiGetAssignmentInfo(props.assignmentId);
  assignment.value = resp.data;
  setDocumentTitle([assignment.value.title]);
  const q = {
    description: assignment.value.description,
    allowed_extension: assignment.value.allowed_extension,
    score: String(assignment.value.score),
    show_score: assignment.value.show_score,
    max_file_size: assignment.value.max_file_size,
  };
  originalQuestion.value = q;
  question.value = structuredClone(q);
  maxFileSize.value = fsize(q.max_file_size);
}

function init() {
  refreshState();
  if (String(courseInfo.value.id) != props.courseId) {
    ApiGetCourseInfo(props.courseId).then((resp) => (courseInfo.value = resp.data));
  }
}

onActivated(init);

// 在离开此页时若尚有未保存更改弹出提醒
onBeforeRouteLeave(async () => {
  if (JSON.stringify(question.value) !== JSON.stringify(originalQuestion.value)) {
    return await createConfirm({
      title: t("unsavedChanges.title"),
      content: t("unsavedChanges.content"),
      confirmationButtonProps: { color: "red" },
    });
  }
});

function normalizeExtensions() {
  question.value.allowed_extension = parseExtensions(question.value.allowed_extension).join(",");
}

async function onExtensionFocus(focused: boolean) {
  if (!focused) {
    // The combobox commits its search text when focus leaves.
    await nextTick();
    normalizeExtensions();
  }
}

function parseFilesize(s: string | null) {
  if (s === null) {
    return NaN;
  }
  const suffix = [
    ["b", 1],
    ["ki", 1024],
    ["k", 1024],
    ["mi", 1048576],
    ["m", 1048576],
    ["gi", 1073741824],
    ["g", 1073741824],
    ["ti", 1099511627776],
    ["t", 1099511627776],
  ] as const;
  let factor = 1;
  s = s.trim().toLowerCase();
  for (const [suf, fac] of suffix) {
    if (s.endsWith(suf)) {
      factor *= fac;
      s = s.slice(0, -suf.length);
    }
  }
  try {
    return Math.floor(parseFloat(s.trim()) * factor);
  } catch {
    return NaN;
  }
}

async function submit(doPublish = false) {
  await nextTick();
  normalizeExtensions();
  if (!(await form.value?.validate())?.valid) {
    sendSnack(t("validationError"));
    return;
  }

  // 检查题目分值
  if (!/\d+/.test(question.value.score)) {
    sendSnack(t("error.scoreNotInt"), "warning");
    return;
  }
  // 检查扩展名
  if (question.value.allowed_extension === "") {
    if (
      await createConfirm({
        content: t("noAllowedExtensionConfirm"),
        confirmationText: t("dialog.cancel"),
        cancellationText: t("dialog.continueAnyway"),
      })
    ) {
      return;
    }
  }
  // 检查文件大小限制
  if (maxFileSize.value !== fsize(question.value.max_file_size)) {
    if (Number.isNaN(maxFileSizeParsed.value)) {
      sendSnack(t("error.fileSize"), "warning");
      return;
    }
    question.value.max_file_size = maxFileSizeParsed.value;
  }

  const wasPublished = assignment.value.published;
  if (
    doPublish &&
    !wasPublished &&
    !(await createConfirm({
      title: assignment.value.title,
      content: t("publishConfirmation"),
      dialogProps: { maxWidth: 240 },
    }))
  ) {
    return;
  }
  try {
    await ApiTeacherModifyAssignment(props.assignmentId, {
      ...question.value,
      score: parseInt(question.value.score),
    });
    sendSnack(t("success.save"), "success");
    if (doPublish) {
      await ApiTeacherPublishAssignment(props.assignmentId);
    }
    await refreshState();
    if (doPublish && !wasPublished) {
      sendSnack(t("success.publish"), "success");
      router.push({ name: "assignments-list", params: { courseId: props.courseId } });
    }
  } catch (error: any) {
    sendSnack(t("error.general") + getGeneralErrorMsg(error), "warning");
  }
}
</script>

<route lang="yaml">
name: assignment-edit
meta:
  title: 编辑作业
  titleEn: Edit Assignment
props: true
</route>

<i18n lang="yaml">
zh:
  nav:
    editAssignment: "编辑作业 {title}"
  editAssignment: 编辑作业
  questionInfo: 题目信息
  questionDescription: 题目描述
  descriptionRequired: 请填写题目描述
  questionScore: 题目分值
  showScore: 向学生显示分数
  allowedExtensions: 扩展名限制
  allowedExtensionsHint: 例如 txt、ipynb 或 zip；多个后缀可用逗号分隔。输入后自动去除前导点、转为小写并去重，留空不限。
  allowedExtensionsPlaceholder: 不限
  fileSizeLimit: 文件大小限制
  noAllowedExtensionConfirm: "没有限制上传文件扩展名。\n规定统一的提交文件格式，批改更方便。"
  buttons:
    saveDraft: 保存草稿
    saveAndPublish: 保存并发布
    save: 保存
  unsavedChanges:
    title: 更改尚未保存
    content: 确定要离开吗？
  validationError: 填写有误，请检查。
  publishConfirmation: 确认发布此作业？
  success:
    save: 保存成功
    publish: 发布成功
  error:
    scoreNotInt: 题目分值应为整数
    fileSize: 文件大小限制格式不对，请检查
en:
  nav:
    editAssignment: "Edit Assignment {title}"
  editAssignment: Edit Assignment
  questionInfo: Question Information
  questionDescription: Question Description
  descriptionRequired: Description is required
  questionScore: Score
  showScore: Show scores to students
  allowedExtensions: Allowed Extensions
  allowedExtensionsHint: For example, txt, ipynb or zip; separate multiple extensions with commas. Leading dots are removed, letters lowercased and duplicates merged after editing. Leave blank for any type.
  allowedExtensionsPlaceholder: Any
  noAllowedExtensionConfirm: "Allowed Extensions is not set.\nWe recommend setting Allowed Extensions for the ease for grading."
  fileSizeLimit: File Size Limit
  buttons:
    saveDraft: Save Draft
    saveAndPublish: Save and Publish
    save: Save
  unsavedChanges:
    title: Unsaved Changes
    content: Are you sure you want to leave?
  validationError: Please check your input for errors.
  publishConfirmation: Confirm to publish this assignment?
  success:
    save: Saved successfully
    publish: Published successfully
  error:
    scoreNotInt: "Score is not an integer!"
    fileSize: "Bad File size limit format!"
</i18n>
