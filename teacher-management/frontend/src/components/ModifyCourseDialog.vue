<template>
  <!-- 此对话框组件兼有开设和修改课程信息功能 -->
  <v-dialog
    v-model="model"
    max-width="1024"
    persistent
    @keydown.esc.stop.prevent="cancelEdit"
  >
    <v-card
      class="px-2 pt-2"
      :prepend-icon="operationType === 'modify' ? `mdi-book-edit` : `mdi-book-plus`"
    >
      <template #title>
        <v-card-title class="text-headline-small my-2" tag="h2">
          <span v-if="operationType === 'modify'"> {{ rosterOnly ? '管理本课程名单' : '名单与课程设置' }} </span>
          <span v-else-if="operationType === 'create'"> 开设课程 </span>
        </v-card-title>
      </template>
      <v-card-text class="pb-0">
        <v-form ref="form" v-model="form_valid">
          <v-row>
            <v-col cols="12">
              <v-text-field
                label="课程名称"
                :disabled="rosterOnly"
                prepend-icon="mdi-format-title"
                v-model="newCourseInfo.title"
                :rules="[(v: string) => !!v || '名称不能为空']"
                variant="underlined"
              />
            </v-col>
            <v-col cols="auto">
              <v-combobox
                id="year"
                :disabled="rosterOnly"
                style="width: 10em"
                :items="yearCandidate"
                suffix="年"
                prepend-icon="mdi-calendar"
                persistent-hint
                v-model="newCourseInfo.year"
                :rules="[
                  (v: number) =>
                    (v > 2018 && v < new Date().getFullYear() + 3) ||
                    '年份应为大于2018的数字，且不得为遥远的未来',
                ]"
                variant="underlined"
                density="compact"
              />
            </v-col>
            <v-col cols="auto">
              <v-select
                style="width: 8em"
                v-model="newCourseInfo.term"
                :disabled="rosterOnly"
                :items="[
                  { title: '春季学期', value: 0 },
                  { title: '夏季学期', value: 1 },
                  { title: '秋季学期', value: 2 },
                ]"
                variant="underlined"
                density="compact"
              />
            </v-col>
            <v-col cols="12">
              <UsersAutocompletes
                label="负责教师"
                :disabled="rosterOnly || !useAppStore().isAdmin"
                v-model="newCourseInfo.teachers"
                prepend-icon="mdi-human-male-board"
                :role-filter="1"
                include-administrators
                :rules="[(v) => v.length > 0 || '负责教师不能为空']"
              />
            </v-col>
            <v-col cols="12">
              <UsersAutocompletes
                label="助教"
                v-model="newCourseInfo.assistants"
                :role-filter="0"
              />
            </v-col>
          </v-row>
          <v-row>
            <v-col>
              <UsersAutocompletes
                label="参与学生"
                v-model="newCourseInfo.students"
                :role-filter="0"
                
                chip-size="x-small"
              />
            </v-col>
            <v-col cols="auto" class="align-self-center pb-8">
              <v-btn icon="mdi-dots-vertical" @click="showBatchImportDialog" />
            </v-col>
            <v-col cols="12">
              <div style="height: 80px"></div>
            </v-col>
          </v-row>
        </v-form>
      </v-card-text>
      <v-card-actions class="pb-5 px-5">
        <DeleteCourseButton v-if="operationType == 'modify' && !rosterOnly"
          :course="course" @deleted="courseDeleted" />
        <v-spacer></v-spacer>
        <v-btn @click="cancelEdit"> 取消 </v-btn>
        <v-btn
          variant="tonal"
          color="primary"
          @click="operationType === 'modify' ? modifyCourse() : createCourse()"
          :disabled="!form_valid"
          text="保存"
        />
      </v-card-actions>
    </v-card>
  </v-dialog>

  <!-- 批量导入学生对话框 -->
  <v-dialog v-model="batchDialog" max-width="768">
    <v-card class="px-2 pt-2" title="批量导入学生">
      <v-card-text>
        <v-textarea
          label="用户名（学号）列表"
          rows="8"
          placeholder="每行填写一个用户名（学号）"
          v-model="batchUsernameList"
        ></v-textarea>
      </v-card-text>
      <v-card-actions class="pb-3 pr-3">
        <v-btn @click="batchDialog = false"> 取消 </v-btn>
        <v-btn @click="batchFillCurrent" text="填入当前数据" />
        <v-spacer />
        <v-btn
          variant="tonal"
          color="warning"
          @click="() => batchAddStudents(true)"
          text="覆盖"
        />
        <v-btn
          variant="tonal"
          color="primary"
          @click="() => batchAddStudents(false)"
          text="添加"
        />
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { VForm } from "vuetify/components";
// import { ApiUpdateCourse, ApiCreateCourse } from "@/api/course";
import {
  ApiCreateCourse,
  ApiUpdateCourse,
  CourseInfo,
  type Course,
} from "@/api/course";
import { useConfirm } from "@/utils/confirm";
import { useAppStore } from "@/stores/app";
import { useUsersStore } from "@/stores/users";
import { BatchLookupUsers } from "@/api/user";
import { getGeneralErrorMsg } from "@/utils/error";

const model = defineModel<boolean>();

const { operationType, course, rosterOnly = false } = defineProps<{
  operationType: "modify" | "create";
  course: Course;
  rosterOnly?: boolean;
}>();

const emit = defineEmits<{
  modified: [a: CourseInfo];
  created: [a: CourseInfo];
  deleted: [id: number];
}>();

const createConfirm = useConfirm();
const { sendSnack } = useAppStore();
const { updateMap, fetchUsersById } = useUsersStore();

const today = new Date();
const yearCandidate = [
  today.getFullYear() + 1,
  today.getFullYear(),
  today.getFullYear() - 1,
];

const form: Ref<VForm | null> = ref(null);

const form_valid = ref(false);

const newCourseInfo = ref({} as CourseInfo);
let initialCourse = "";

async function cancelEdit() {
  if (
    JSON.stringify(newCourseInfo.value) !== initialCourse &&
    !(await createConfirm({ content: "放弃尚未保存的课程修改？" }))
  )
    return;
  model.value = false;
}

const batchDialog = ref(false);
const batchUsernameList = ref("");

watch(model, async (newModel) => {
  // 每当对话框打开时进行初始化
  if (newModel) {
    // 所有需要通过调用 getUsersById 获知姓名的用户
    const outstandingUsers: number[] = [];
    outstandingUsers.push(...course.assistants);
    // outstandingUsers.push(...course.students.slice(0, ABBREV_STU_COUNT));
    outstandingUsers.push(...course.students);
    fetchUsersById(Array.from(new Set(outstandingUsers).values()));
    updateMap(course.teachers);

    newCourseInfo.value = {
      ...course,
      teachers: course.teachers.map((u) => u.id),
    };
    initialCourse = JSON.stringify(newCourseInfo.value);
    await nextTick();
  }
});

async function modifyCourse() {
  try {
    const resp = await ApiUpdateCourse(newCourseInfo.value.id!, newCourseInfo.value, !!rosterOnly);
    sendSnack(`修改课程“${newCourseInfo.value.title}”成功`, "success");
    emit("modified", resp.data);
    model.value = false;
  } catch (error: any) {
    sendSnack(
      `修改课程“${newCourseInfo.value.title}”失败：${getGeneralErrorMsg(error)}`,
      "warning",
    );
  }
}

async function createCourse() {
  if (!(await form.value?.validate())?.valid) {
    return;
  }
  try {
    const resp = await ApiCreateCourse(newCourseInfo.value);
    sendSnack(`创建课程 ${newCourseInfo.value.title} 成功`, "success");
    emit("created", resp.data);
  } catch (error: any) {
    sendSnack(
      `创建课程“${newCourseInfo.value.title}”失败：${getGeneralErrorMsg(error)}`,
      "warning",
    );
  }
  model.value = false;
}

function showBatchImportDialog() {
  batchDialog.value = !batchDialog.value;
}

async function batchFillCurrent() {
  // batchUsernameList.value = getUsersById(newCourseInfo.value.students)
  //   .map((u) => u.username)
  //   .join("\n");

  if (!newCourseInfo.value.students.length) {
    batchUsernameList.value = "";
    return;
  }
  batchUsernameList.value = (
    await BatchLookupUsers([], newCourseInfo.value.students)
  ).success
    .map(({ user }) => user.username)
    .join("\n");
}

async function batchAddStudents(overwrite: boolean = false) {
  const names = batchUsernameList.value.split("\n").filter((s) => s.trim() !== "");

  if (names.length === 0) {
    if (!overwrite) {
      sendSnack("请填写一些用户名（学号），每行一个。");
      return;
    }
    const confirm = await createConfirm({
      content: `没有填写任何用户名（学号），要清空参与用户列表吗？`,
      confirmationButtonProps: { color: "warning" },
    });
    if (!confirm) return;
  }

  const result = await BatchLookupUsers(names);

  // 不许在此处填入教师
  const teachers = result.success
    .filter(({ user: { role } }) => role != 0)
    .map(({ user }) => user.username);

  updateMap(result.success.map(({ user }) => user));

  const failmsg =
    (result.fail.length ? `\n有 ${result.fail.length} 个用户名未找到。` : "") +
    (teachers.length
      ? `\n有 ${teachers.length} 个用户（${teachers.join("、")}）是教师，不能添加。`
      : "");

  if (overwrite) {
    const set = new Set(
      result.success.filter(({ user: { role } }) => role == 0).map(({ user }) => user.id),
    );

    newCourseInfo.value.students = Array.from(set);

    sendSnack(
      `成功导入 ${set.size} 个用户。` + failmsg,
      result.fail.length || teachers.length ? "warning" : "success",
    );
  } else {
    const delta = new Set(
      result.success.filter(({ user: { role } }) => role == 0).map(({ user }) => user.id),
    ).difference(new Set(newCourseInfo.value.students));

    newCourseInfo.value.students.push(...delta);

    sendSnack(
      `成功添加 ${delta.size} 个用户。` + failmsg,
      result.fail.length || teachers.length ? "warning" : "success",
    );
  }

  batchUsernameList.value = result.fail.map(({ Idx }) => names[Idx]).join("\n");

  if (!result.fail.length && !teachers.length) {
    batchDialog.value = false;
  }
  form.value?.validate(); // 刷新表单状态
}

function courseDeleted(id: number) {
  emit('deleted', id);
  model.value = false;
}
</script>
