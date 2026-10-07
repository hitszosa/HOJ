<template>
  <v-container>
    <!-- 此页面兼为题目作答（学生）和题目预览（教师）页面 -->
    <TopNavigation
      :items="[
        { title: t('nav.coursesList'), to: { name: 'courses-list' } },
        {
          title: courseInfo.title,
          to: { name: 'assignments-list', params: { courseId } },
        },
        { title: assignment.title },
      ]"
    />

    <v-skeleton-loader :loading="loading" type="card">
      <v-empty-state
        v-if="assignment.description === ''"
        :title="t('assignment.emptyTitle')"
        width="100%"
      >
        <template #text>
          <p>
            {{
              asStudent && !asAssistant
                ? t("assignment.emptyHint.student")
                : t("assignment.emptyHint.staff")
            }}
          </p>
        </template>
      </v-empty-state>
      <QuestionTemplate
        v-else
        :assignment
        :disable="!asStudent || !assignment.submit_allowed || noEdit"
        :last-submission="latestSubmission"
        @update:selected-file="selectedFile = $event"
        :view-result="isDue(assignment)"
        width="100%"
      />

      <Fab
        v-if="asStudent && assignment.submit_allowed"
        @click="noEdit ? confirmReedit() : confirmSubmit()"
        app
        :disabled="uploading"
        :color="noEdit ? 'indigo' : 'green'"
        size="x-large"
        rounded
        :prepend-icon="noEdit ? 'mdi-content-save-all-outline' : 'mdi-upload'"
        :text="noEdit ? t('button.reEdit') : t('button.submit')"
      />
    </v-skeleton-loader>
  </v-container>
</template>

<script setup lang="ts">
import { Submission } from "@/api/course";
import {
  ApiGetSubmissions,
  ApiCreateSubmission,
  ApiGetCourseInfo,
  ApiGetAssignmentInfo,
} from "@/api/course";
import type { Assignment } from "@/api/course";
import { useAppStore } from "@/stores/app";
import { setDocumentTitle } from "@/utils/page";
import { storeToRefs } from "pinia";
import { useConfirm } from "@/utils/confirm";
import { ApiFinishFile, ApiTouchFile, S3UploadFile } from "@/api/file";
import { isDue, parseExtensions } from "@/utils/assignments";
import { useI18n } from "vue-i18n";
import { getGeneralErrorMsg } from "@/utils/error";
import { AxiosProgressEvent } from "axios";
import { partial as filesizePartial } from "filesize";

const props = defineProps<{
  assignmentId: string;
  courseId: string;
}>();

const { t } = useI18n();
const store = useAppStore();
const { courseInfo, user: me } = storeToRefs(store);
const { sendSnack } = store;
const createConfirm = useConfirm();
const fsize = filesizePartial({ base: 2, standard: "iec", precision: 3 });

const asStudent = computed(() => {
  return courseInfo.value?.students?.includes(me.value.id);
});

const asAssistant = computed(() => {
  return courseInfo.value?.assistants?.includes(me.value.id);
});

const router = useRouter();

// data
const assignment = ref({} as Assignment);
const latestSubmission = ref(null as null | Submission);

// component state
const selectedFile = ref<File | null>(null);
const loading = ref(true);
const noEdit = ref(false); // 锁定提交
const uploading = ref(false);

async function init() {
  try {
    assignment.value = (await ApiGetAssignmentInfo(props.assignmentId)).data;
    if (props.courseId !== String(assignment.value.course)) {
      const confirmed = await createConfirm({
        content: t("assignment.mismatch", {
          title: assignment.value.title,
          courseId: props.courseId,
        }),
      });
      if (confirmed) {
        router.push({
          name: "assignment-do",
          params: {
            courseId: String(assignment.value.course),
            assignmentId: props.assignmentId,
          },
        });
        setTimeout(init, 25);
        return;
      }
    }
    courseInfo.value = (await ApiGetCourseInfo(props.courseId)).data;

    setDocumentTitle([assignment.value.title]);

    if (!asStudent.value) {
      loading.value = false;
      return;
    }

    const submissions = (await ApiGetSubmissions(props.courseId, props.assignmentId))
      .data;
    // 每个同学每个作业只存一次提交
    latestSubmission.value =
      submissions.find((sub) => sub.user.id === me.value.id) || null;
    // 如已有提交，则初始时锁定界面，需要学生确认才能覆盖/修改
    noEdit.value = !!latestSubmission.value;

    loading.value = false;
  } catch (error: any) {
    const kind = error?.response?.data?.error;
    if (kind === "authorization_error") {
      sendSnack(t("error.unauthorized"), "error", -1);
    } else {
      sendSnack(getGeneralErrorMsg(error), "warning");
    }
  }
}

onActivated(init);

function formatProgress(rate?: number, estimated?: number): string {
  if (!rate || !estimated) {
    return "";
  }
  const estimatedSec = estimated % 60;
  const estimatedMin = Math.floor(estimated / 60);
  return t("submission.uploadProgress", {
    rate: fsize(rate),
    estimatedSec: estimatedSec.toPrecision(2),
    // 这个参数须命名为 n，才能利用 vue-i18n 默认的复数（零）处理
    n: estimatedMin,
  });
}

async function confirmSubmit() {
  if (!selectedFile.value) {
    sendSnack(t("error.noFileSelected"));
    return;
  }
  if (selectedFile.value.size > assignment.value.max_file_size) {
    sendSnack(
      t("error.fileLarge", {
        maxFileSize: fsize(assignment.value.max_file_size),
      }),
      "warning",
    );
    return;
  }
  const extensions = parseExtensions(assignment.value.allowed_extension);
  const filename = selectedFile.value.name.toLowerCase();
  if (
    extensions.length > 0 &&
    !extensions.some((extension) => filename.endsWith(`.${extension}`))
  ) {
    sendSnack(
      t("error.fileExtension", {
        allowedExtensions: extensions.join(", "),
      }),
      "warning",
    );
    return;
  }

  const confirmed = await createConfirm({
    title: t("dialog.submit.title"),
    content: t("dialog.submit.content"),
  });
  if (!confirmed) return;

  sendSnack(t("submission.uploading"), "info", -1);
  store.snack.progress.show = true; // 此两句需置于 sendSnack 后面，因为它会覆写这两个属性
  store.snack.closable = false;
  uploading.value = true;
  try {
    const presigned = (
      await ApiTouchFile(selectedFile.value.name, {
        type: "submission",
        assignment_id: assignment.value.id,
      })
    ).data;

    store.snack.progress.indeterminate = false;
    await S3UploadFile(
      presigned.url,
      presigned.params,
      selectedFile.value,
      (e: AxiosProgressEvent) => {
        if (uploading.value) {
          store.snack.progress.value = e.progress! * 100;
          store.snack.message =
            t("submission.uploading") + "\n" + formatProgress(e.rate, e.estimated);
        }
      },
    );
    store.snack.progress.indeterminate = true;
    await ApiFinishFile(presigned.ident);

    await ApiCreateSubmission(props.assignmentId, presigned.ident);
    store.snack.progress.show = false;
    sendSnack(t("success.submit"), "success", 5000);
    router.push({
      name: "assignments-list",
      params: { courseId: String(props.courseId) },
    });
    await init(); // 刷新
  } catch (error: any) {
    sendSnack(getGeneralErrorMsg(error), "warning", -1);
  } finally {
    uploading.value = false;
  }
}

async function confirmReedit() {
  const confirmed = await createConfirm({
    title: t("dialog.reedit.title"),
    content: t("dialog.reedit.content"),
  });
  if (confirmed) {
    noEdit.value = false;
  }
}
</script>

<route lang="yaml">
name: assignment-do
meta:
  title: 作业题目
  titleEn: Assignment
props: true
</route>

<i18n lang="yaml">
zh:
  assignment:
    emptyTitle: 还没有题目 🙃
    emptyHint:
      student: 稍后再来看看？
      staff: 返回上一页来编辑题目。
    mismatch: "作业“{title}”不属于编号为 {courseId} 的课程。\n按下“确定”以转到正确的页面。"
  button:
    reEdit: 重新修改
    submit: 提交
  dialog:
    submit:
      title: 确定提交吗？
      content: 在作业截止之前可以重新修改。
    reedit:
      title: 确定要重新修改吗？
      content: 修改答案后请重新点击提交。
  submission:
    uploading: 正在提交作业，请勿关闭网页……
    uploadProgress: "{rate}/s，预计还需 {estimatedSec} 秒 | {rate}/s，预计还需 {n} 分 {estimatedSec} 秒 | {rate}/s，预计还需 {n} 分 {estimatedSec} 秒"
  success:
    submit: 提交成功！
  error:
    noFileSelected: 未选中文件！
    unauthorized: 你没有查看此作业的权限！
    fileLarge: "上传文件大小超过限制。最大只能提交 {maxFileSize} 的文件。"
    fileExtension: "选取的文件扩展名不符合要求。只能提交以下格式的文件：{allowedExtensions}"
en:
  assignment:
    emptyTitle: No Problems Yet 🙃
    emptyHint:
      student: Check back later?
      staff: Go back to edit the assignment.
    mismatch: "Assignment “{title}” does not belong to course id {courseId}.\nPress “Confirm” to navigate to correct page."
  button:
    reEdit: Revise
    submit: Submit
  dialog:
    submit:
      title: Confirm Submission?
      content: You can modify your submission before the deadline.
    reedit:
      title: Continue to revise?
      content: "Don't forget to click Submit again after modification."
  submission:
    uploading: Submitting, please wait...
    uploadProgress: "{rate}/s, {estimatedSec} sec remaining | {rate}/s, {n} min {estimatedSec} sec remaining | {rate}/s, {n} min {estimatedSec} sec remaining"
  success:
    submit: Submission successful!
  error:
    noFileSelected: No file selected!
    unauthorized: You are not authorized to view this assignment!
    fileLarge: "File size exceeds the limit. Maximum file size allowed is {maxFileSize}."
    fileExtension: "The selected file extension is not allowed. Only the following file formats are allowed: {allowedExtensions}"
</i18n>
