<template>
  <v-container fluid>
    <TopNavigation
      class="flex-shrink-0"
      :items="[
        { title: t('nav.coursesList'), to: { name: 'courses-list' } },
        {
          title: courseInfo.title,
          to: { name: 'assignments-list', params: { courseId } },
        },
        {
          title: assignment.title + ' ' + t('nav.submissions'),
          to: { name: 'submissions-list', params: { courseId, assignmentId } },
          disabled: false,
        },
      ]"
    />
    <ViewStudentsSubmissions
      v-if="currentIndex >= 0"
      :submission="currentIndex >= 0 ? submissionsList[currentIndex] : ({} as Submission)"
      :assignment
      :no-next="currentIndex === 0"
      @next="nextSubmission"
      @score-updated="onScoreUpdated"
    />
    <v-alert v-else type="info" variant="tonal" class="my-4">暂无可查看的提交记录</v-alert>
  </v-container>
</template>

<script setup lang="ts">
import { ApiGetAssignmentInfo, ApiGetCourseInfo, ApiGetSubmissions } from "@/api/course";
import type { Assignment, Submission } from "@/api/course";
import { useAppStore } from "@/stores/app";
import { useGoTo } from "vuetify";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  courseId: string;
  assignmentId: string;
  submissionId: string;
}>();

const { t } = useI18n();
const router = useRouter();
const goTo = useGoTo();
const app = useAppStore();
const { courseInfo } = storeToRefs(app);

const assignment = ref({} as Assignment);
const submissionsList = ref([] as Submission[]);
let loadGeneration = 0;
let needsRefresh = false;

watch(
  () => props.courseId,
  () => {
    if (String(courseInfo.value.id) !== props.courseId) {
      ApiGetCourseInfo(props.courseId).then((resp) => (courseInfo.value = resp.data));
    }
  },
  { immediate: true },
);

async function loadSubmissions() {
  const generation = ++loadGeneration;
  const [assignmentResponse, submissionsResponse] = await Promise.all([
    ApiGetAssignmentInfo(props.assignmentId),
    ApiGetSubmissions(props.courseId, props.assignmentId),
  ]);
  if (generation !== loadGeneration) return;
  const lines = submissionsResponse.data;
  lines.sort((a, b) =>
    a.submit_time < b.submit_time ? -1 : +(a.submit_time > b.submit_time),
  );
  assignment.value = assignmentResponse.data;
  submissionsList.value = lines;
}
watch(() => [props.assignmentId, props.submissionId], loadSubmissions, {
  immediate: true,
});
onDeactivated(() => {
  needsRefresh = true;
  loadGeneration++;
});
onActivated(() => {
  if (needsRefresh) {
    needsRefresh = false;
    void loadSubmissions();
  }
});

const currentIndex = computed(() =>
  submissionsList.value.findIndex((sub) => sub.id == parseInt(props.submissionId)),
);

function navigateToSubmission(id: number) {
  router.push({
    name: "submission",
    params: {
      courseId: props.courseId,
      assignmentId: props.assignmentId,
      submissionId: String(id),
    },
  });
  goTo(0);
}

function nextSubmission() {
  const next = submissionsList.value.at(currentIndex.value - 1);
  if (next) navigateToSubmission(next.id);
}

function onScoreUpdated({
  submissionId,
  score,
}: {
  submissionId: number;
  score: number;
}) {
  const sub = submissionsList.value.find((s) => s.id === submissionId);
  if (sub) {
    sub.score = score;
    sub.status = 1;
  }
}

</script>

<route lang="yaml">
name: submission
meta:
  title: 提交记录
  titleEn: Submissions
props: true
</route>

<i18n lang="yaml">
zh:
  nav:
    submissions: 提交记录
en:
  nav:
    submissions: Submissions
</i18n>
