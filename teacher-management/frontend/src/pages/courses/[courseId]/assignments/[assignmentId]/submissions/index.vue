<template>
  <v-container>
    <TopNavigation
      :items="[
        { title: t('nav.coursesList'), to: { name: 'courses-list' } },
        {
          title: courseInfo.title,
          to: { name: 'assignments-list', params: { courseId } },
        },
        { title: assignmentInfo.title + ' ' + t('nav.submissions') },
      ]"
    />

    <v-skeleton-loader :loading="loading.submissions" type="heading,table">
      <h2 class="my-4 text-headline-large font-weight-light">
        {{ assignmentInfo.title }} {{ t("submissions.title") }}
      </h2>
      <v-row class="my-auto">
        <v-spacer style="flex: 4 0 auto" />
        <v-col style="flex: 1 0 12em">
          <v-text-field
            v-model="search"
            density="compact"
            append-inner-icon="mdi-magnify"
            variant="solo-filled"
            flat
            :label="t('search')"
            single-line
            :error-messages="searchError"
          />
        </v-col>
        <v-col cols="auto">
          <v-btn
            @click="downloadGradingReport"
            color="indigo"
            prepend-icon="mdi-file-excel"
            :text="t('submissions.downloadReport')"
            :loading="reportDownloading"
          />
        </v-col>
        <v-col cols="auto">
          <v-btn
            @click="download_packed"
            color="indigo"
            prepend-icon="mdi-briefcase-download"
            :text="t('submissions.downloadAll')"
            :loading="packDownloading > 0"
          />
        </v-col>
      </v-row>

      <!-- 已提交名单 -->
      <v-card width="100%">
        <v-card-title class="d-flex align-center">
          <h3 class="text-headline-small my-2">{{ t("submissions.submittedList") }}</h3>
        </v-card-title>
        <v-data-table
          class="submission-table"
          :headers="
            (
              [
                { title: t('submissions.headers.id'), value: 'id' },
                { title: t('submissions.headers.username'), value: 'username' },
                { title: t('submissions.headers.realName'), value: 'real_name' },
                { title: t('submissions.headers.score'), value: 'score' },
                { title: t('submissions.headers.submitTime'), value: 'submit_time_text' },
                { title: t('submissions.headers.status'), value: 'status_text' },
                {
                  title: t('submissions.headers.view'),
                  value: 'btn',
                  sortable: false,
                  align: 'center',
                  // filterable: false,
                },
              ] as const
            ).map((col) => ({ sortable: true, ...col }))
          "
          :items="submissionsData"
          :search="search"
          :sort-by="[{ key: 'submit_time_text', order: 'desc' }]"
          multi-sort
          :page-text="t('pagination1', { start: '{0}', end: '{1}', total: '{2}' })"
          @update:currentItems="(l: any[]) => (filteredItemsCount1 = l.length)"
        >
          <template #[`item.btn`]="{ item }">
            <v-btn
              variant="text"
              :to="{
                name: 'submission',
                params: {
                  courseId: String(courseId),
                  assignmentId: String(assignmentId),
                  submissionId: String(item.id),
                },
              }"
              icon="mdi-eye"
            />
          </template>
        </v-data-table>
      </v-card>
    </v-skeleton-loader>

    <!-- 未提交名单 -->
    <template v-if="!loading.noSubmissions">
      <v-card class="my-4" v-if="noSubmissionStudents.length">
        <v-card-title class="d-flex align-center">
          <h3 class="text-headline-small my-2">
            {{ t("submissions.notSubmittedList") }}
          </h3>
        </v-card-title>
        <v-data-table
          class="submission-table"
          :headers="[
            {
              title: t('submissions.headers.username'),
              value: 'username',
              sortable: true,
            },
            {
              title: t('submissions.headers.realName'),
              value: 'real_name',
              sortable: true,
            },
          ]"
          :items="noSubmissionStudents"
          :search="search"
          :sort-by="[{ key: 'username', order: 'asc' }]"
          multi-sort
          :page-text="t('pagination2', { start: '{0}', end: '{1}', total: '{2}' })"
          @update:currentItems="(l: any[]) => (filteredItemsCount2 = l.length)"
        />
      </v-card>
      <v-card v-else>
        <v-empty-state :text="t('submissions.allSubmitted')" />
      </v-card>
    </template>
    <AssignmentStatistics class="my-4" :assignment-id="parseInt(assignmentId)" />
  </v-container>
</template>

<script setup lang="ts">
import type { Assignment } from "@/api/course";
import type { UserInfo } from "@/api/user";
import {
  ApiGetSubmissions,
  ApiGetNoSubmissionStudentList,
  FormatDate,
  ApiGetAssignmentInfo,
  Submission,
  ApiGetCourseInfo,
} from "@/api/course";
import { storeToRefs } from "pinia";
import { useAppStore } from "@/stores/app";
import { getExtension, saveBlobAsFile } from "@/utils/download";
import { ApiGradingReport } from "@/api/grading";
import { createGradingReport } from "@/utils/gradingReport";
import { BlobWriter, BlobReader, ZipWriter } from "@zip.js/zip.js";
import { ApiDownloadFile, S3DownloadFile } from "@/api/file";
import { useI18n } from "vue-i18n";
import { getGeneralErrorMsg } from "@/utils/error";
import { AxiosProgressEvent, isAxiosError } from "axios";
import { partial as filesizePartial } from "filesize";

const props = defineProps<{
  courseId: string;
  assignmentId: string;
}>();

const store = useAppStore();
const { courseInfo } = storeToRefs(store);
const { sendSnack } = store;
const { t } = useI18n();
const fsize = filesizePartial({ base: 2, standard: "iec", precision: 3 });

// Data
const submissionsData = ref([] as Submission[]);
// const submissionsData = ref(Array(16).fill({ id: 123 } as Submission));
const noSubmissionStudents = ref([{} as UserInfo]);
// const noSubmissionStudents = ref(Array(16).fill({ username: "qaq" } as UserInfo));
const assignmentInfo = ref({} as Assignment);

// Component State
// 2601：教师希望「已提交名单」和「未提交名单」共用一个搜索词，便于快速确定某个学生是否提交作业，并排除学生不存在于本班级的情况。
// 在 Grader 平台上，教师常常为一个实际课程划分班级创建多个「课程」。若学生开课后申请调班，可能导致系统中的班级不一致。
const search = ref("");
const loading = reactive({
  submissions: true,
  noSubmissions: true,
});
const packDownloading = ref(0);
const reportDownloading = ref(false);
const filteredItemsCount1 = ref(0);
const filteredItemsCount2 = ref(0);

const searchError = computed(() =>
  search.value && !filteredItemsCount1.value && !filteredItemsCount2.value
    ? [t("studentNotFound")]
    : [],
);

watch(
  () => props.courseId,
  () => {
    if (String(courseInfo.value.id) != props.courseId) {
      ApiGetCourseInfo(props.courseId).then((resp) => (courseInfo.value = resp.data));
    }
  },
  { immediate: true },
);

async function init() {
  loading.submissions = loading.noSubmissions = true;

  try {
    const { data } = await ApiGetNoSubmissionStudentList(
      props.courseId,
      props.assignmentId,
    );
    noSubmissionStudents.value = data;
    loading.noSubmissions = false;
    assignmentInfo.value = (await ApiGetAssignmentInfo(props.assignmentId)).data;

    const { data: subs } = await ApiGetSubmissions(props.courseId, props.assignmentId);
    submissionsData.value = subs.map((v) => ({
      ...v,
      username: v.user.username,
      real_name: v.user.real_name,
      status_text: v.status === 1 ? t("graded") : t("notGraded"),
      submit_time_text: FormatDate(v.submit_time),
    }));
    loading.submissions = false;
  } catch (e: any) {
    const kind = e.response?.data.error;
    if (kind === "authorization_error") {
      sendSnack(t("unauthorized"), "error", -1);
    } else {
      sendSnack(getGeneralErrorMsg(e), "warning");
    }
  }
}

onActivated(init);

async function downloadGradingReport() {
  if (reportDownloading.value) return;
  reportDownloading.value = true;
  const assignmentId = Number(props.assignmentId);
  const title = (assignmentInfo.value.title || "assignment")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .slice(0, 100)
    .replace(/[. ]+$/g, "");
  try {
    const { data } = await ApiGradingReport(assignmentId);
    saveBlobAsFile(
      await createGradingReport(data),
      `grading_${assignmentId}_${title}_${new Date().toISOString().slice(0, 10)}.xlsx`,
    );
    sendSnack(t("submissions.reportFinished"));
  } catch (error) {
    sendSnack(
      t("submissions.reportError", {
        error: isAxiosError(error) ? getGeneralErrorMsg(error) : String(error),
      }),
      "error",
      -1,
    );
  } finally {
    reportDownloading.value = false;
  }
}

async function download_packed() {
  const zipFileWriter = new BlobWriter();
  const zipWriter = new ZipWriter(zipFileWriter);

  const handleDownloadProgress = (i: number, e: AxiosProgressEvent) => {
    if (packDownloading.value && packDownloading.value <= i + 1) {
      packDownloading.value = i + 1;
      store.snack.progress.value = e.progress! * 67;
      if (e.rate) {
        store.snack.message =
          t("download_pack.download") +
          ` (${i + 1}/${submissionsData.value.length}) ${fsize(e.rate!)}/s`;
      } else {
        store.snack.message = t("download_pack.download");
      }
    }
  };

  const handleCompressProgress = async (i: number, progress: number, total: number) => {
    if (packDownloading.value && packDownloading.value <= i + 1) {
      store.snack.progress.value = 67 + (progress / total) * 33;
      store.snack.message =
        t("download_pack.zip") +
        ` (${i + 1}/${submissionsData.value.length}) ${fsize(progress)} / ${fsize(total)}`;
    }
  };

  sendSnack(t("download_pack.download"), "info", -1);
  store.snack.progress.show = true;
  store.snack.closable = false;
  store.snack.progress.indeterminate = false;
  packDownloading.value = 1;

  for (const [i, s] of submissionsData.value.entries()) {
    try {
      const presigned = (await ApiDownloadFile(s.file)).data;
      const blob = (
        await S3DownloadFile(presigned.url, (e) => handleDownloadProgress(i, e))
      ).data;

      const extension = getExtension(presigned.original_file_name);
      const suffix = extension ? "." + extension : "";
      await zipWriter.add(
        `${s.user.username}_${s.user.real_name}_${assignmentInfo.value.title}${suffix}`,
        new BlobReader(blob),
        { onprogress: (...e) => handleCompressProgress(i, ...e) },
      );
    } catch {
      sendSnack(t("download_pack.error"), "warning");
      console.log(i, s.file);
      packDownloading.value = 0;
      return;
    }
  }
  sendSnack(t("download_pack.zip"), "info", -1);
  store.snack.progress.indeterminate = true;
  zipWriter.close();
  const zipFileBlob = await zipFileWriter.getData();
  saveBlobAsFile(
    zipFileBlob,
    `${assignmentInfo.value.title}_${FormatDate(new Date())}.zip`,
  );
  store.snack.progress.show = false;
  packDownloading.value = 0;
  sendSnack(t("download_pack.finish"));
}
</script>

<style scoped>
.submission-table :deep(th),
.submission-table :deep(td) {
  white-space: nowrap;
  word-break: normal;
}
.submission-table :deep(table) {
  min-width: 760px;
}
.submission-table :deep(.v-table__wrapper) {
  overflow-x: auto;
}
</style>

<route lang="yaml">
name: submissions-list
meta:
  title: 提交记录
  titleEn: Submissions
props: true
</route>

<i18n lang="yaml">
zh:
  nav:
    submissions: 提交记录
  submissions:
    title: 提交记录
    downloadAll: 下载所有提交的文件
    downloadReport: 导出全作业成绩 Excel
    reportFinished: 成绩已导出
    reportError: "导出成绩失败：{error}"
    submittedList: 已提交名单
    notSubmittedList: 未提交名单
    allSubmitted: 所有参与课程学生均已提交👌
    headers:
      id: 提交编号
      username: 用户名/学号
      realName: 姓名
      score: 分数
      submitTime: 提交时间
      status: 批改情况
      view: 查看提交
  search: 搜索
  pagination1: "{start}-{end}，共 {total} 份"
  pagination2: "{start}-{end}，共 {total} 人"
  unauthorized: 你没有权限查看提交记录
  download_pack:
    download: 打包下载中……
    zip: 压缩中……
    finish: 打包下载已完成
    error: 出错了，无法打包下载
  studentNotFound: 该学生不存在于本课程或班级
en:
  nav:
    submissions: Submissions
  submissions:
    title: Submissions
    downloadAll: Download all submissions
    downloadReport: Export all grades to Excel
    reportFinished: Grades exported
    reportError: "Could not export grades: {error}"
    submittedList: Submissions List
    notSubmittedList: Not Submitted List
    allSubmitted: All students have submitted. 👌
    headers:
      id: Submission ID
      username: Username/ID
      realName: Name
      score: Score
      submitTime: Submission Time
      status: Status
      view: View Submission
  search: Search
  pagination1: "{start}-{end} of {total} items"
  pagination2: "{start}-{end} of {total} items"
  unauthorized: You are not authorized to view submissions
  download_pack:
    download: Downloading...
    zip: Zipping...
    finish: Download finished
    error: Error occurred while downloading
  studentNotFound: Student not found
</i18n>
