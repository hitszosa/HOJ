<template>
  <v-container>
    <TopNavigation
      :items="[
        { title: t('nav.coursesList'), to: { name: 'courses-list' } },
        { title: courseInfo.title },
      ]"
    />
    <div class="assignment-heading d-flex align-center flex-wrap ga-4 my-4">
      <h2 class="ma-0 font-weight-light text-headline-large">
        {{
          courseInfo.title
            ? t("assignmentsOn", { course: courseInfo.title })
            : t("assignments")
        }}
      </h2>
      <v-chip v-if="asAssistant" color="deep-purple-lighten-2">{{ t("TA") }}</v-chip>
      <PageFilter v-model="filter" :label="t('filterAssignments')" />
    </div>
    <HojCourseBridge :course-id="Number(props.courseId)" :can-manage="asTeacher" :can-view-grades="asTeacher || asAssistant">
      <template #actions="{ createHref, gradesHref }">
        <div class="course-actions d-flex align-center flex-wrap ga-2 mb-4" :aria-label="t('courseActions')">
          <v-btn v-if="createHref" :href="createHref" prepend-icon="mdi-code-braces" color="primary" variant="flat">{{ t('createAssignment') }}</v-btn>
          <v-btn v-if="asTeacher" prepend-icon="mdi-account-group" variant="outlined" @click="manageRoster">{{ t(store.isAdmin ? 'rosterAndSettings' : 'manageRoster') }}</v-btn>
          <v-btn v-if="gradesHref" :href="gradesHref" prepend-icon="mdi-chart-box-outline" variant="outlined">{{ t('programmingGrades') }}</v-btn>
          <v-btn v-if="assignments.length && (asTeacher || asAssistant)" prepend-icon="mdi-file-chart-outline" variant="outlined" :to="{ name: 'course-statistics', params: { courseId: props.courseId } }">{{ t('fileGrades') }}</v-btn>
          <DeleteCourseButton v-if="store.isAdmin" :course="courseInfo" @deleted="$router.replace({ name: 'courses-list' })" />
        </div>
      </template>
    </HojCourseBridge>
    <ModifyCourseDialog v-if="asTeacher" v-model="rosterDialog" operation-type="modify" :course="rosterCourse" :roster-only="!store.isAdmin" @modified="init" @deleted="$router.replace({ name: 'courses-list' })" />

    <v-skeleton-loader :loading="loading.assignments" type="card@2">
      <v-empty-state
        v-if="assignments.length && filteredAssignments.length === 0"
        :title="t('noMatchingAssignments')"
        width="100%"
      />
      <VirtualCollection
        v-if="filteredAssignments.length"
        :items="filteredAssignments"
        :mode="courseView"
        :estimated-row-height="320"
      >
        <template #default="{ item: assignment }">
          <v-card
            :hover="!isList"
            :flat="isList"
            :rounded="isList ? 0 : undefined"
            class="cursor-auto"
            :class="{ 'assignment-list-row': isList }"
          >
            <component
              v-if="isList"
              :is="
                asTeacher || asAssistant || (asStudent && assignment.published)
                  ? RouterLink
                  : 'div'
              "
              :to="defaultAssignmentPage(assignment)"
              class="assignment-list-link"
              :title="t('openAssignment', { title: assignment.title })"
            >
              <div class="assignment-list-content">
                <h3
                  class="assignment-list-title text-title-medium text-truncate ma-0"
                  :title="assignment.title"
                >
                  {{ assignment.title }}
                </h3>
                <p
                  class="assignment-list-summary text-body-small text-medium-emphasis ma-0 mt-1"
                >
                  <span>
                    {{ t(hasBegun(assignment) ? "dueTime" : "startTime") }}:
                    {{
                      FormatDate(
                        hasBegun(assignment)
                          ? assignment.due_time
                          : assignment.start_time,
                      )
                    }}
                  </span>
                  <span
                    v-if="
                      (asTeacher || asAssistant) &&
                      assignment.published &&
                      hasBegun(assignment)
                    "
                  >
                    · {{ assignment.submit_count }}{{ t("份", assignment.submit_count) }}
                  </span>
                  <span v-if="asStudent && !loading.submissions">
                    ·
                    <template v-if="getSubmission(assignment.id)">
                      {{ t("score") }}: {{ getScore(getSubmission(assignment.id)!) }}
                    </template>
                    <template v-else>{{ t("notSubmittedShort") }}</template>
                  </span>
                </p>
              </div>
              <v-chip
                v-if="!assignment.published"
                color="orange-darken-1"
                size="x-small"
                class="ml-2 flex-shrink-0"
              >
                {{ t("draft") }}
              </v-chip>
              <v-chip
                v-else-if="assignment.submit_allowed"
                color="green"
                size="x-small"
                class="ml-2 flex-shrink-0"
              >
                {{ t("open") }}
              </v-chip>
              <v-chip
                v-else-if="isDue(assignment)"
                size="x-small"
                class="ml-2 flex-shrink-0"
              >
                {{ t("closed") }}
              </v-chip>
              <v-chip v-else color="indigo" size="x-small" class="ml-2 flex-shrink-0">
                {{ t("notStarted") }}
              </v-chip>
              <v-icon
                v-if="asTeacher || asAssistant || (asStudent && assignment.published)"
                class="ml-2 flex-shrink-0"
                size="small"
                aria-hidden="true"
                >mdi-chevron-right</v-icon
              >
            </component>
            <template v-else>
              <v-card-title class="py-4">
                <h3
                  class="text-title-large my-0 text-truncate text-left"
                  :title="assignment.title"
                  style="min-width: 0"
                >
                  {{ assignment.title }}
                </h3>
                <div class="d-flex align-center flex-wrap ga-2 mt-2">
                  <v-chip
                    v-if="
                      (asTeacher || asAssistant) &&
                      assignment.published &&
                      hasBegun(assignment)
                    "
                    color="primary"
                    size="small"
                  >
                    {{ assignment.submit_count }}{{ t("份", assignment.submit_count) }}
                  </v-chip>
                  <v-spacer />
                  <!-- 作业状态 -->
                  <v-chip
                    color="orange-darken-1"
                    size="small"
                    v-if="!assignment.published"
                  >
                    {{ t("draft") }}
                  </v-chip>
                  <v-chip
                    v-else-if="assignment.submit_allowed"
                    color="green"
                    size="small"
                  >
                    {{ t("open") }}
                  </v-chip>
                  <v-chip v-else-if="isDue(assignment)" size="small">
                    {{ t("closed") }}
                  </v-chip>
                  <v-chip v-else color="indigo" size="small">
                    {{ t("notStarted") }}
                  </v-chip>
                </div>
              </v-card-title>
              <!-- 在教师端，作业未发布时，若作业开始时间晚于当前时间，则无进度条显示，否则出现颜色为灰色（muted）的进度条显示，以便提醒教师可能设置了错误的（有悖常理的）时间 -->
              <DueIndicator
                :disabled="!assignment.submit_allowed"
                :start-time="assignment.start_time"
                :due-time="assignment.due_time"
                :muted="
                  assignment.published === false && assignment.submit_allowed === true
                "
                :show="
                  !(assignment.published === false && assignment.submit_allowed === false)
                "
                class="mb-2"
              />

              <!-- 卡片内容 -->
              <v-card-text class="pt-0">
                <v-row density="compact">
                  <v-col cols="6">
                    <strong class="text-grey">{{ t("startTime") }}</strong>
                    <div class="info-field">{{ FormatDate(assignment.start_time) }}</div>
                  </v-col>
                  <v-col cols="6">
                    <strong class="text-grey">{{ t("dueTime") }}</strong>
                    <div class="info-field">{{ FormatDate(assignment.due_time) }}</div>
                  </v-col>
                </v-row>
                <v-skeleton-loader
                  v-if="asStudent"
                  :loading="loading.submissions"
                  type="text"
                >
                  <v-row density="compact">
                    <v-col v-if="getSubmission(assignment.id) === null">
                      <strong class="text-grey">
                        {{
                          t(
                            assignment.submit_allowed
                              ? "notSubmittedYet"
                              : "notSubmitted",
                          )
                        }}
                      </strong>
                    </v-col>
                    <template v-else>
                      <v-col cols="6">
                        <strong class="text-grey">{{ t("lastSubmission") }}</strong>
                        <div class="info-field">
                          {{ FormatDate(getSubmission(assignment.id)!.submit_time) }}
                        </div>
                      </v-col>
                      <v-col cols="6">
                        <strong class="text-grey">{{ t("score") }}</strong>
                        <div class="info-field">
                          {{ getScore(getSubmission(assignment.id)!) }}
                        </div>
                      </v-col>
                    </template>
                  </v-row>
                </v-skeleton-loader>
              </v-card-text>

              <v-divider />
            </template>

            <v-card-actions
              v-if="!compactList || asTeacher || asAssistant"
              :class="{ 'assignment-list-actions': isList }"
            >
              <!-- 老师按钮 发布的作业 -->
              <template
                v-if="!isList && (asTeacher || asAssistant) && assignment.published"
              >
                <v-btn
                  v-if="hasBegun(assignment)"
                  :to="submissionsPage(assignment)"
                  :prepend-icon="assignment.submit_count ? 'mdi-tray-full' : 'mdi-tray'"
                  :text="t('viewSubmissions')"
                />
              </template>
              <!-- 老师按钮 未发布的作业 -->
              <template
                v-if="!compactList && (asTeacher || asAssistant) && !assignment.published"
              >
                <v-btn
                  class="px-1"
                  :disabled="assignment.published"
                  :to="editAssignmentPage(assignment)"
                  prepend-icon="mdi-file-document-edit-outline"
                  :text="t('editQuestion')"
                />
                <v-btn
                  class="px-1"
                  prepend-icon="mdi-calendar-clock-outline"
                  :text="t('modifyAssignmentInfo')"
                  @click="openModifyAssignmentDialog(assignment)"
                />
              </template>

              <v-spacer v-if="!isList" />

              <!-- 学生按钮 -->
              <template v-if="!compactList && asStudent && assignment.published">
                <v-btn
                  :to="viewAssignmentPage(assignment)"
                  color="primary"
                  :text="studentActionText(assignment)"
                />
              </template>

              <v-menu v-if="asTeacher || asAssistant">
                <template #activator="{ props }">
                  <v-btn
                    v-bind="props"
                    icon="mdi-dots-vertical"
                    density="compact"
                    :title="t('assignmentActions')"
                    :aria-label="`${t('assignmentActions')}: ${assignment.title}`"
                  />
                </template>

                <template v-if="assignment.published">
                  <v-list slim>
                    <!-- 同为助教和学生时，该路由页面为作答 -->
                    <v-list-item
                      v-if="!asStudent || compactList"
                      :to="viewAssignmentPage(assignment)"
                      prepend-icon="mdi-eye-outline"
                      :title="
                        asStudent ? studentActionText(assignment) : t('previewQuestion')
                      "
                    />

                    <v-list-item
                      :to="editAssignmentPage(assignment)"
                      prepend-icon="mdi-file-document-edit-outline"
                      :title="t('editQuestion')"
                    />
                    <v-list-item
                      prepend-icon="mdi-calendar-clock-outline"
                      @click="openModifyAssignmentDialog(assignment)"
                      :title="t('modifyAssignmentInfo')"
                    />
                    <v-list-item
                      @click="confirmDeleteAssignment(assignment)"
                      class="text-red"
                      prepend-icon="mdi-delete-forever"
                      :title="t('deleteAssignment')"
                    />
                  </v-list>
                </template>

                <template v-if="!assignment.published">
                  <v-list slim>
                    <v-list-item
                      :to="viewAssignmentPage(assignment)"
                      prepend-icon="mdi-eye-outline"
                      :title="t('previewQuestion')"
                    />
                    <v-list-item
                      v-if="compactList"
                      prepend-icon="mdi-calendar-clock-outline"
                      :title="t('modifyAssignmentInfo')"
                      @click="openModifyAssignmentDialog(assignment)"
                    />
                    <v-list-item
                      @click="confirmDeleteAssignment(assignment)"
                      class="text-red"
                      prepend-icon="mdi-delete-forever"
                      :title="t('deleteAssignment')"
                    />
                  </v-list>
                </template>
              </v-menu>
            </v-card-actions>
          </v-card>
        </template>
      </VirtualCollection>
    </v-skeleton-loader>

    <!-- 保留已有文件作业的修改入口，新作业统一进入题单工作区 -->
    <ModifyAssignmentDialog
      v-model="modifyAssignmentDialog"
      operation-type="modify"
      :assignment="tempAssignment"
    />
  </v-container>
</template>

<script setup lang="ts">
import { computed, shallowRef } from "vue";
import {
  ApiDeleteAssignment,
  ApiGetCourseAssignments,
  ApiGetCourseInfo,
  ApiGetSubmissions,
  FormatDate,
} from "@/api/course";
import { useAppStore } from "@/stores/app";
import { usePreferenceStore } from "@/stores/theme";
import { useDisplay } from "vuetify";
import { RouterLink } from "vue-router";
import type { Assignment, Submission, Course } from "@/api/course";
import { storeToRefs } from "pinia";
import { setDocumentTitle } from "@/utils/page";
import { hasBegun, isDue } from "@/utils/assignments";
import { useConfirm } from "@/utils/confirm";
import { useI18n } from "vue-i18n";
import { getGeneralErrorMsg } from "@/utils/error";
import VirtualCollection from "@/components/VirtualCollection.vue";
import PageFilter from "@/components/PageFilter.vue";

const props = defineProps<{
  courseId: string;
}>();

const store = useAppStore();
const { courseInfo, user: me } = storeToRefs(store);
const asTeacher = computed(() => me.value.role === 2 || (me.value.role === 1 && courseInfo.value?.teachers?.some(t => t.id === me.value.id)));
const rosterDialog = ref(false);
const rosterCourse = ref({} as Course);
function manageRoster() {
  rosterCourse.value = structuredClone(toRaw(courseInfo.value));
  rosterDialog.value = true;
}
const { sendSnack } = store;
const { t, locale } = useI18n();
const { courseView } = storeToRefs(usePreferenceStore());
const isList = computed(() => courseView.value === "list");
const { xs } = useDisplay();
const compactList = computed(() => isList.value && xs.value);

const asStudent = computed(() => {
  return courseInfo.value?.students?.includes(me.value.id);
});

const asAssistant = computed(() => {
  return courseInfo.value?.assistants?.includes(me.value.id);
});

// route objects used in templates

const editAssignmentPage = (a: Assignment) => ({
  name: "assignment-edit" as const,
  params: { courseId: String(a.course), assignmentId: String(a.id) },
});

const viewAssignmentPage = (a: Assignment) => ({
  name: "assignment-do" as const,
  params: { courseId: String(a.course), assignmentId: String(a.id) },
});

const submissionsPage = (a: Assignment) => ({
  name: "submissions-list" as const,
  params: { courseId: String(a.course), assignmentId: String(a.id) },
});

function defaultAssignmentPage(a: Assignment) {
  if (asTeacher.value || asAssistant.value) {
    if (!a.published) return editAssignmentPage(a);
    return hasBegun(a) ? submissionsPage(a) : viewAssignmentPage(a);
  }
  return asStudent.value && a.published ? viewAssignmentPage(a) : undefined;
}

function studentActionText(assignment: Assignment) {
  if (!hasBegun(assignment)) return t("previewQuestion");
  if (!assignment.submit_allowed) return t("viewSubmission");
  return t(getSubmission(assignment.id) ? "viewOrReviseSubmission" : "goSubmission");
}

// Data

const assignments = ref([] as Assignment[]);
const filter = ref("");
const filteredAssignments = computed(() => {
  const query = filter.value.trim().toLocaleLowerCase();
  return query
    ? assignments.value.filter((assignment) =>
        assignment.title.toLocaleLowerCase().includes(query),
      )
    : assignments.value;
});

// Submission records are read-only on this page and replaced after each fetch.
const submissions = shallowRef<Submission[]>([]);

// Component state

const loading = reactive({
  courseInfo: true,
  assignments: true,
  submissions: true,
});

const modifyAssignmentDialog = ref(false);

const tempAssignment = ref({} as Assignment);

const submissionsByAssignment = computed(() => {
  const byAssignment = new Map<number, Submission>();
  for (const submission of submissions.value) {
    if (submission.user.id === me.value.id && !byAssignment.has(submission.assignment)) {
      byAssignment.set(submission.assignment, submission);
    }
  }
  return byAssignment;
});

function getSubmission(assignmentId: number) {
  return submissionsByAssignment.value.get(assignmentId) ?? null;
}

function getScore(sub: Submission) {
  return sub.score != null && sub.status === 1
    ? sub.score
    : locale.value === "en"
      ? "None"
      : "无";
}

function openModifyAssignmentDialog(a: Assignment) {
  tempAssignment.value = a;
  modifyAssignmentDialog.value = true;
}

const createConfirm = useConfirm();

async function confirmDeleteAssignment(a: Assignment) {
  // tempAssignment.value = a;
  const confirmed = await createConfirm({
    content: "一旦删除就不可撤销！",
    titleComponent: () => "",
    cardProps: {
      title: `确定删除“${a.title}”吗？`,
      prependIcon: "mdi-alert",
      maxWidth: 400,
    },
    confirmationText: "确认删除",
  });

  if (confirmed) deleteAssignment(a);
}

async function deleteAssignment(assignment: Assignment) {
  try {
    await ApiDeleteAssignment(assignment.id);
    sendSnack(`删除作业“${assignment.title}”成功`);
    const resp = await ApiGetCourseAssignments(props.courseId);
    assignments.value = resp.data;
  } catch (error: any) {
    // 何以出错?
    //   一种错误场景 -> 多个会话同时打开，在其他会话已经将该作业删除了再尝试删除该作业。

    const kind = error?.response?.data?.error;
    const detail = kind === "not_found" ? t("fail.not_found") : getGeneralErrorMsg(error);
    sendSnack(t("fail.delete", { title: assignment.title, detail }), "warning");
  }
}

async function init() {
  try {
    courseInfo.value = (await ApiGetCourseInfo(props.courseId)).data;
    loading.courseInfo = false;
    setDocumentTitle([courseInfo.value.title]);

    // 只有学生需要拉取提交记录，老师不需要
    if (asStudent.value) {
      ApiGetSubmissions(props.courseId).then((resp) => {
        submissions.value = resp.data;
        loading.submissions = false;
      });
    }

    assignments.value = (await ApiGetCourseAssignments(props.courseId)).data;
    loading.assignments = false;
  } catch (error: any) {
    const kind = error?.response?.data?.error;
    if (kind === "authorization_error") {
      sendSnack(t("fail.authorization_error"), "error", -1);
    } else {
      sendSnack(getGeneralErrorMsg(error), "error");
    }
  } finally {
    loading.courseInfo = false;
  }
}

onActivated(init);
</script>

<style scoped>
.assignment-heading h2 {
  min-width: 0;
  flex: 1 1 20rem;
  overflow-wrap: anywhere;
}

.assignment-list-row {
  display: flex;
  align-items: center;
}

.assignment-list-link {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  padding: 12px 16px;
  color: inherit;
  text-decoration: none;
}

a.assignment-list-link:hover,
a.assignment-list-link:focus-visible {
  background: rgba(var(--v-theme-on-surface), var(--v-hover-opacity));
}

a.assignment-list-link:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: -2px;
}

.assignment-list-content,
.assignment-list-title {
  flex: 1;
  min-width: 0;
}

.assignment-list-summary {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.assignment-list-actions {
  flex: 0 1 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  min-width: 0;
  max-width: 100%;
}
</style>

<route lang="yaml">
name: assignments-list
meta:
  title: 作业列表
props: true
</route>

<i18n lang="yaml">
zh:
  courseActions: 课程操作
  createAssignment: 布置作业
  rosterAndSettings: 名单与课程设置
  manageRoster: 管理名单
  programmingGrades: 成绩与导出
  fileGrades: 文件作业成绩
  assignments: 课程作业
  assignmentsOn: "{course}作业"
  filterAssignments: 筛选当前课程作业
  noMatchingAssignments: 当前课程没有匹配的作业
  TA: 助教
  份: 份
  draft: 未发布
  open: 开放中
  closed: 已截止
  notStarted: 未开始
  startTime: 开始时间
  dueTime: 截止时间
  notSubmittedYet: 你尚未提交此作业
  notSubmitted: 你未提交过此作业
  lastSubmission: 上次提交
  score: 得分
  viewSubmissions: 查看提交
  previewQuestion: 预览题目
  editQuestion: 编辑题目
  modifyAssignmentInfo: 修改信息
  deleteAssignment: 删除作业
  viewOrReviseSubmission: 查看/修改作答
  goSubmission: 开始作答
  viewSubmission: 查看作答
  openAssignment: "打开作业：{title}"
  notSubmittedShort: 未提交
  assignmentActions: 作业操作
  fail:
    delete: "删除作业“{title}”失败：{detail}"
    not_found: 该作业已被删除
    authorization_error: 你没有查看该课程的权限。
en:
  courseActions: Course actions
  createAssignment: Create assignment
  rosterAndSettings: Roster and course settings
  manageRoster: Manage roster
  programmingGrades: Grades & export
  fileGrades: File assignment grades
  assignments: Assignments
  assignmentsOn: "Assignments on {course}"
  filterAssignments: Filter assignments in this course
  noMatchingAssignments: No matching assignments in this course
  TA: TA
  份: " submission | {' '}submissions"
  draft: DRAFT
  open: OPEN
  closed: CLOSED
  notStarted: NOT STARTED
  startTime: Starting at
  dueTime: Closing at
  notSubmittedYet: No submissions yet
  notSubmitted: No submission from you
  lastSubmission: Last Submission
  score: Score
  viewSubmissions: View Submissions
  previewQuestion: View
  editQuestion: Edit
  modifyAssignmentInfo: Change Info
  deleteAssignment: Delete
  viewOrReviseSubmission: View / Revise
  goSubmission: Go
  viewSubmission: View
  openAssignment: "Open assignment: {title}"
  notSubmittedShort: Not submitted
  assignmentActions: Assignment actions
  fail:
    delete: "Failed to delete assignment “{title}”: {detail}"
    not_found: "The assignment has already been deleted. "
    authorization_error: "You are not authorized to view this course."
</i18n>
