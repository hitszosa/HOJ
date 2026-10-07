<template>
  <v-btn v-if="store.isAdmin && course.id" color="error" variant="outlined"
    prepend-icon="mdi-delete-outline" :loading="busy" :disabled="busy"
    @click="removeCourse">{{ text('删除课程', 'Delete course') }}</v-btn>
</template>

<script setup lang="ts">
import { ApiDeleteCourse, ApiGetCourseAssignments, type Course } from '@/api/course';
import { useAppStore } from '@/stores/app';
import { useConfirm } from '@/utils/confirm';
import { getGeneralErrorMsg } from '@/utils/error';
import { useI18n } from 'vue-i18n';

const props = defineProps<{ course: Course }>();
const emit = defineEmits<{ deleted: [id: number] }>();
const store = useAppStore();
const createConfirm = useConfirm();
const { locale } = useI18n({ useScope: 'global' });
const text = (zh: string, en: string) => locale.value === 'en' ? en : zh;
const busy = ref(false);

async function removeCourse() {
  if (!store.isAdmin || busy.value || !props.course.id) return;
  const course = props.course;
  busy.value = true;
  try {
    const confirmed = await createConfirm({
      title: text('删除课程', 'Delete course'),
      content: text(`确定删除课程“${course.title}”吗？关联班级、编程题单、普通作业、学生提交及对应成绩也会实际删除，无法在页面中恢复。`,
        `Delete course “${course.title}”? Its linked class, programming assignments, regular assignments, student submissions and related grades will be permanently deleted. There is no restore action in the platform.`),
      confirmationText: text('确认删除', 'Delete course'),
      confirmationButtonProps: { color: 'error' },
    });
    if (!confirmed) return;
    const count = (await ApiGetCourseAssignments(course.id)).data.filter(a => a.published).length;
    if (count && !(await createConfirm({
      content: text(`此课程有 ${count} 个已发布的作业，再次确认删除课程“${course.title}”？`,
        `This course has ${count} published assignments. Confirm deletion of “${course.title}”?`),
      confirmationText: text('确认删除', 'Delete course'),
      confirmationButtonProps: { color: 'error' },
    }))) return;
    await ApiDeleteCourse(course.id);
    emit('deleted', course.id);
    store.sendSnack(text(`已删除课程“${course.title}”`, `Deleted course “${course.title}”`));
  } catch (error: any) {
    store.sendSnack(getGeneralErrorMsg(error), 'error');
  } finally {
    busy.value = false;
  }
}
</script>
