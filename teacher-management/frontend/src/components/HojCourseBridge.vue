<template>
  <section v-if="courseId" class="my-4" aria-label="作业题单">
    <slot name="actions" :create-href="creationHref" :grades-href="gradesHref">
      <div class="d-flex align-center flex-wrap ga-2 mb-4">
        <v-btn v-if="creationHref" :href="creationHref" prepend-icon="mdi-code-braces" color="primary" variant="flat">{{ text('布置作业', 'Create assignment') }}</v-btn>
        <v-btn v-if="gradesHref" :href="gradesHref" prepend-icon="mdi-chart-box-outline" variant="outlined">{{ text('成绩与导出', 'Grades & export') }}</v-btn>
      </div>
    </slot>
    <h3 class="text-title-large mb-3">{{ text('作业题单', 'Assignment problem sets') }}</h3>
    <v-skeleton-loader v-if="loadingBatches" type="list-item-two-line" />
    <v-alert v-else-if="batchError" type="warning" variant="tonal">
      {{ batchError }}
      <v-btn size="small" variant="text" @click="refresh">{{ text('重试', 'Retry') }}</v-btn>
    </v-alert>
    <v-list v-else-if="batches.length" class="rounded border" lines="two">
      <v-list-item v-for="batch in batches" :key="batch.batch_id" :title="batch.title"
        :subtitle="isStaff ? text(`${batch.problem_count} 道题 · ${batch.staff?.submitted_count ?? 0} / ${batch.student_count} 人已提交`, `${batch.problem_count} problems · ${batch.staff?.submitted_count ?? 0} / ${batch.student_count} students submitted`) : text(`已通过 ${batch.done} / ${batch.problem_count} 题`, `Passed ${batch.done} / ${batch.problem_count} problems`)"
        :href="`/assignments/${batch.batch_id}`"
        prepend-icon="mdi-code-braces" append-icon="mdi-chevron-right">
        <template v-if="canAuthor" #append>
          <div class="d-flex ga-2" @click.stop>
            <v-btn :href="`/assignments/${batch.batch_id}?edit=1`" size="small" variant="outlined" @click.stop>{{ text('编辑', 'Edit') }}</v-btn>
            <v-btn color="error" size="small" variant="text" :loading="deleting === batch.batch_id" :disabled="deleting !== null" @click.stop.prevent="removeAssignment(batch)">{{ text('删除', 'Delete') }}</v-btn>
          </div>
        </template>
      </v-list-item>
    </v-list>
    <p v-else class="text-body-medium text-medium-emphasis">{{ canAuthor ? text('暂无作业题单，点击上方「布置作业」选择题单、自编或导入题目。', 'No assignment problem sets yet. Use Create assignment above to select, create or import problems.') : text('暂无作业题单。', 'No assignment problem sets yet.') }}</p>
    <HojStudentRoster v-if="offering?.role==='teacher' && linked && !loadingBatches && !batchError" :course-id="courseId" :offering-id="linked.offering_id" :batches="batches" class="mt-6"/>
  </section>
</template>
<script setup lang="ts">
import { instance as api } from '@/api/axiosInstance';
import { useAppStore } from '@/stores/app';
import { getGeneralErrorMsg } from '@/utils/error';
import { useI18n } from 'vue-i18n';
import { useConfirm } from '@/utils/confirm';
const props = defineProps<{ courseId?: number; canManage?: boolean; canViewGrades?: boolean }>();
const store = useAppStore();
const confirm=useConfirm();
const deleting=ref<number|null>(null);
async function removeAssignment(batch:ProgrammingBatch){
  if(!canAuthor.value || deleting.value!==null)return;
  if(!(await confirm({title:text('删除作业','Delete assignment'),content:text(`确定实际删除作业“${batch.title}”吗？题目关联、学生提交代码及成绩也会删除，无法在页面中恢复。`,`Permanently delete “${batch.title}”, its assigned problems, submitted code and grades?`),confirmationText:text('确认删除','Delete'),confirmationButtonProps:{color:'error'}})))return;
  deleting.value=batch.batch_id;
  try{const response=await fetch(`/api/batches/${batch.batch_id}`,{method:'DELETE',credentials:'same-origin'});const body=await response.json();if(!response.ok)throw new Error(body.message||text('删除失败','Deletion failed'));store.sendSnack(text('作业已实际删除','Assignment permanently deleted'));await refresh();}catch(e:any){store.sendSnack(e instanceof Error ? e.message : getGeneralErrorMsg(e),'error');}finally{deleting.value=null;}
}
const { locale } = useI18n();
const text = (zh: string, en: string) => locale.value === 'en' ? en : zh;
type ProgrammingBatch = { batch_id:number; title:string; status:string; problem_count:number; done:number; student_count:number; staff?:{submitted_count:number} };
type Offering = { role: string; status: string };
const batches = ref<ProgrammingBatch[]>([]);
const offering = ref<Offering>();
const loadingBatches = ref(false);
const batchError = ref('');
const linked = ref<{course_id:number;offering_id:number}>();
const isStaff = computed(() => ['teacher', 'ta'].includes(offering.value?.role ?? ''));
const canAuthor = computed(() => props.canManage && offering.value?.role === 'teacher' && offering.value?.status === 'active');
const creationHref = computed(() => canAuthor.value && linked.value ? `/library?view=mine&oid=${linked.value.offering_id}` : null);
const gradesHref = computed(() => props.canViewGrades && isStaff.value && linked.value ? `/programming/grades/${linked.value.offering_id}` : null);
let sequence = 0;
let activated = false;
async function refresh() {
  const current = ++sequence;
  const courseId = props.courseId;
  batches.value = [];
  offering.value = undefined;
  linked.value = undefined;
  batchError.value = '';
  if (!courseId) return;
  loadingBatches.value = true;
  try {
    const links: {course_id:number;offering_id:number}[] = (await api.get('/api/hoj/links')).data;
    if (current !== sequence) return;
    linked.value = links.find(link => link.course_id === courseId);
    if (!linked.value) throw new Error(text('当前课程尚未关联题单工作区，请联系管理员完成课程关联后重试。', 'This course has no linked problem set workspace. Ask an administrator to link it, then retry.'));
    const response = await fetch(`/api/offerings/${linked.value.offering_id}?include_insights=false`, { credentials:'same-origin' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || text('编程作业暂时无法加载', 'Programming assignments unavailable'));
    if (current !== sequence) return;
    offering.value = body.data.offering;
    batches.value = body.data.batches;
  } catch (error: any) {
    if (current !== sequence) return;
    batchError.value = getGeneralErrorMsg(error);
    if (!linked.value) store.sendSnack(batchError.value, 'warning');
  } finally { if (current === sequence) loadingBatches.value = false; }
}
watch(() => props.courseId, refresh);
onMounted(refresh);
onActivated(() => { if (activated) void refresh(); activated = true; });
onDeactivated(() => { ++sequence; });
onUnmounted(() => { ++sequence; });
</script>
