<template>
  <section id="students" :aria-label="text('学生名单', 'Students')">
    <h3 class="text-title-large mb-3">{{ text('学生名单', 'Students') }}</h3>
    <div class="d-flex align-center flex-wrap ga-3 mb-3">
      <v-select v-if="assignments.length" :model-value="selectedBatch" @update:model-value="changeBatch" :items="assignments" item-title="title" item-value="batch_id" :label="text('查看作业成绩', 'Assignment results')" variant="outlined" density="compact" hide-details class="assignment-select"/>
      <v-text-field :model-value="searchInput" @update:model-value="onSearch" :label="text('搜索学号或姓名', 'Search student number or name')" prepend-inner-icon="mdi-magnify" variant="outlined" density="compact" hide-details maxlength="100" class="student-search"/>
      <v-select :model-value="pageSize" @update:model-value="changePageSize" :items="[20, 50]" :label="text('每页人数', 'Students per page')" variant="outlined" density="compact" hide-details class="page-size"/>
    </div>
    <v-progress-linear v-if="loading" indeterminate :aria-label="text('加载学生名单', 'Loading students')"/>
    <v-alert v-else-if="error" type="error" variant="tonal">{{ error }}<v-btn variant="text" @click="load">{{ text('重试', 'Retry') }}</v-btn></v-alert>
    <template v-else>
      <v-table v-if="students.length" class="rounded border">
        <thead><tr><th>{{ text('学号', 'Student number') }}</th><th>{{ text('姓名', 'Name') }}</th><th v-if="selectedBatch">{{ text('作业成绩', 'Assignment score') }}</th><th v-if="selectedBatch">{{ text('通过题数', 'Passed problems') }}</th><th>{{ text('成绩与代码', 'Results & code') }}</th></tr></thead>
        <tbody><tr v-for="student in students" :key="student.user_id">
          <td>{{ student.student_no || student.user_id }}</td>
          <td><v-btn variant="text" :to="studentRoute(student)">{{ student.nick }}</v-btn></td>
          <td v-if="selectedBatch"><template v-if="student.grade"><v-btn variant="text" :to="studentRoute(student)">{{ student.grade.score }} / 100</v-btn><span class="text-body-small text-medium-emphasis">{{ student.grade.attempts===0 ? text('未提交','Not submitted') : student.grade.pending>0 ? text('有题目待评测','Judging in progress') : '' }}</span></template><span v-else>—</span></td>
          <td v-if="selectedBatch">{{ student.grade ? `${student.grade.passed} / ${student.grade.problem_count}` : '—' }}</td>
          <td><v-btn variant="text" :to="studentRoute(student)">{{ text('查看详情', 'View details') }}</v-btn></td>
        </tr></tbody>
      </v-table>
      <p v-else class="my-4 text-medium-emphasis">{{ text('暂无匹配的学生。', 'No matching students.') }}</p>
      <div class="d-flex align-center flex-wrap justify-space-between ga-2 mt-3">
        <p class="text-body-small text-medium-emphasis">{{ text(`共 ${total} 位学生 · 第 ${page} / ${pageCount} 页`, `${total} students · Page ${page} / ${pageCount}`) }}</p>
        <v-pagination v-if="pageCount>1" :model-value="page" @update:model-value="changePage" :length="pageCount" :total-visible="5" density="comfortable" :aria-label="text('学生名单分页', 'Student pages')"/>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
const props = defineProps<{ courseId: number; offeringId: number; batches: {batch_id:number;title:string;status:string}[] }>();
const route = useRoute(), router = useRouter();
const { locale } = useI18n();
const text = (zh: string, en: string) => locale.value === 'en' ? en : zh;
type Student = { user_id: string; student_no: string; nick: string; grade: {score:number;passed:number;problem_count:number;attempts:number;pending:number}|null };
type Roster = { students: Student[]; total: number; page: number; page_size: number };
const students = ref<Student[]>([]), total = ref(0), loading = ref(false), error = ref(''), searchInput = ref('');
const queryString = (value: unknown) => typeof value === 'string' ? value : '';
const positive = (value: unknown, fallback: number) => /^\d+$/.test(queryString(value)) && Number(value)>0 ? Number(value) : fallback;
const page = computed(() => positive(route.query.studentPage, 1));
const pageSize = computed(() => route.query.studentPageSize === '50' ? 50 : 20);
const search = computed(() => queryString(route.query.studentSearch));
const assignments=computed(()=>props.batches.filter(b=>['published','closed'].includes(b.status)).sort((a,b)=>b.batch_id-a.batch_id));
const selectedBatch=computed(()=>assignments.value.find(b=>b.batch_id===positive(route.query.studentBatch,0))?.batch_id || assignments.value[0]?.batch_id);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined, sequence = 0;
function studentRoute(student: Student) {
  return { path: `/courses/${props.courseId}/students/${encodeURIComponent(student.user_id)}`, query: {...route.query,studentBatch:selectedBatch.value ? String(selectedBatch.value) : undefined} };
}
function changeBatch(value:number){void router.replace({query:{...route.query,studentBatch:String(value),studentPage:undefined}});}
function updateQuery(nextPage: number, nextSize: number, nextSearch: string) {
  return router.replace({ query: { ...route.query, studentPage: nextPage>1 ? String(nextPage) : undefined, studentPageSize: nextSize===50 ? '50' : undefined, studentSearch: nextSearch || undefined } });
}
function changePage(value: number) { void updateQuery(value, pageSize.value, search.value); }
function changePageSize(value: number) { void updateQuery(1, value===50 ? 50 : 20, search.value); }
function onSearch(value: string) {
  searchInput.value = value;
  clearTimeout(timer); controller?.abort(); ++sequence;
  students.value = []; loading.value = true;
  timer = setTimeout(() => {
    timer = undefined;
    const value = searchInput.value.trim();
    if (value === search.value && page.value === 1) void load();
    else void updateQuery(1, pageSize.value, value);
  }, 300);
}
async function load() {
  clearTimeout(timer); timer = undefined;
  const current = ++sequence;
  controller?.abort(); controller = new AbortController();
  students.value = []; error.value = ''; loading.value = true;
  searchInput.value = search.value;
  const params = new URLSearchParams({ page: String(page.value), page_size: String(pageSize.value), search: search.value });
  if(selectedBatch.value)params.set('batch_id',String(selectedBatch.value));
  try {
    const response = await fetch(`/api/offerings/${props.offeringId}/student-roster?${params}`, { credentials: 'same-origin', signal: controller.signal });
    const body = await response.json();
    if (!response.ok) throw Error(body.message || text('学生名单加载失败', 'Failed to load students'));
    if (current !== sequence) return;
    const result: Roster = body.data;
    total.value = result.total;
    if (result.page !== page.value) { await updateQuery(result.page, result.page_size, search.value); return; }
    students.value = result.students;
  } catch (e) {
    if (current === sequence) error.value = e instanceof Error ? e.message : String(e);
  } finally { if (current === sequence) loading.value = false; }
}
watch(() => [props.offeringId, page.value, pageSize.value, search.value, selectedBatch.value], load, { immediate: true });
onBeforeUnmount(() => { clearTimeout(timer); ++sequence; controller?.abort(); });
</script>

<style scoped>
.student-search { flex: 1 1 240px; }
.assignment-select { flex: 1 1 240px; }
.page-size { flex: 0 0 150px; }
</style>
