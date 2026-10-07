<template>
  <!-- 此对话框组件兼有新建和修改作业信息功能 -->
  <v-dialog v-model="model" max-width="768">
    <v-card class="px-2 pt-2">
      <v-card-title class="text-headline-small my-2" tag="h2">
        <span v-if="operationType === 'modify'"> {{ t("modifyAssignmentInfo") }} </span>
        <span v-else-if="operationType === 'create'">
          {{ t("createAssignment") }}
        </span>
      </v-card-title>
      <v-card-text class="pb-0">
        <v-form ref="form" v-model="form_valid">
          <v-row>
            <v-col cols="12">
              <v-text-field
                :label="t('assignmentTitle')"
                prepend-icon="mdi-format-title"
                v-model="title"
                :rules="[(v: string) => !!v || t('titleRequired')]"
              />
            </v-col>
          </v-row>

          <v-row>
            <v-col cols="12" sm="6">
              <DateTimePicker
                :label="t('startTime')"
                prepend-icon="mdi-calendar-start"
                v-model="startTime"
              />
            </v-col>
            <v-col cols="12" sm="6">
              <DateTimePicker
                :label="t('dueTime')"
                prepend-icon="mdi-calendar-minus"
                ref="dueTimePickerRef"
                v-model="dueTime"
              />
            </v-col>
          </v-row>
          <v-row class="px-2 d-flex align-end ga-2">
            <span class="mr-3">{{ t("quickActions.title") }}</span>
            <span>
              <v-btn rounded size="small" @click="setDeltaDueTime(7)">
                {{ t("quickActions.close1w") }}
              </v-btn>
            </span>
            <span>
              <v-btn rounded size="small" @click="setDeltaDueTime(14)">
                {{ t("quickActions.close2w") }}
              </v-btn>
            </span>
            <span>
              <v-btn rounded size="small" @click="setDeltaDueTime(30)">
                {{ t("quickActions.close1m") }}
              </v-btn>
            </span>
          </v-row>
          <v-switch
            v-model="showScore"
            :label="t('showScore')"
            color="primary"
            hide-details
            class="mt-4"
          />
        </v-form>
      </v-card-text>
      <v-card-actions class="pb-5 pr-5 mt-4">
        <v-btn @click="model = false" :text="t('dialog.cancel')" />
        <v-btn
          variant="tonal"
          color="primary"
          @click="operationType === 'modify' ? modifyAssignment() : createAssignment()"
          :disabled="!form_valid"
          :text="t('dialog.confirm')"
        />
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { VForm } from "vuetify/components";
import { ApiUpdateAssignment, ApiCreateAssignment } from "@/api/course";
import type { Assignment } from "@/api/course";
import { addWeeks, addDays } from "date-fns";
import { useConfirm } from "@/utils/confirm";
import { useAppStore } from "@/stores/app";
import { useI18n } from "vue-i18n";
import { getGeneralErrorMsg } from "@/utils/error";
import DateTimePicker from "./DateTimePicker.vue";

const model = defineModel<boolean>();

const props = defineProps<{
  operationType: "modify" | "create";
  assignment: Assignment;
}>();

const emit = defineEmits<{
  modified: [a: Assignment];
  created: [a: Assignment];
}>();

const createConfirm = useConfirm();
const { sendSnack } = useAppStore();
const { t } = useI18n();

const { operationType, assignment } = toRefs(props);

const form: Ref<VForm | null> = ref(null);

const form_valid = ref(false);

const title = ref("");
const startTime = ref(new Date());
const dueTime = ref(new Date());
const showScore = ref(false);
const dueTimePickerRef: Ref<InstanceType<typeof DateTimePicker> | null> = ref(null);

watch(model, (newModel) => {
  // 每当对话框打开时进行初始化
  if (newModel) {
    switch (operationType.value) {
      case "modify":
        title.value = assignment.value.title;
        startTime.value = new Date(assignment.value.start_time);
        dueTime.value = new Date(assignment.value.due_time);
        showScore.value = assignment.value.show_score;
        break;
      case "create": {
        const now = new Date();
        now.setMinutes(Math.floor(now.getMinutes() / 20) * 20 + 10, 0, 0);
        title.value = "";
        startTime.value = now;
        dueTime.value = addWeeks(now, 1);
        showScore.value = false;
      }
    }
  }
});

const validateFormAndMaybeAskForConfirm = async () =>
  (await form.value?.validate())?.valid &&
  (startTime.value <= dueTime.value ||
    (await createConfirm({ content: t("weirdDueTime") })));

function setDeltaDueTime(days: number) {
  dueTimePickerRef.value?.setNewValue(addDays(startTime.value, days));
}

const makeAssignmentInfo = () => ({
  title: title.value,
  course: assignment.value.course,
  start_time: startTime.value,
  due_time: dueTime.value,
  show_score: showScore.value,
  type: 1,
});

async function modifyAssignment() {
  if (!(await validateFormAndMaybeAskForConfirm())) return;

  try {
    const resp = await ApiUpdateAssignment(assignment.value.id, makeAssignmentInfo());
    sendSnack(t("success.modify", { title: title.value }), "success");
    emit("modified", resp.data);
    Object.assign(assignment.value, resp.data);
  } catch (error: any) {
    // 何以出错？
    //   一种错误场景是修改一个不存在的作业。

    const kind = error?.response?.data?.error;
    const detail = kind === "not_found" ? t("fail.not_found") : getGeneralErrorMsg(error);
    sendSnack(t("fail.modify", { title: title.value, detail }), "warning");
  }
  model.value = false;
}

async function createAssignment() {
  if (!(await validateFormAndMaybeAskForConfirm())) {
    return;
  }
  try {
    const resp = await ApiCreateAssignment(makeAssignmentInfo());
    sendSnack(t("success.create", { title: title.value }), "success");
    emit("created", resp.data);
  } catch (error: any) {
    sendSnack(
      t("fail.create", { title: title.value, detail: getGeneralErrorMsg(error) }),
      "warning",
    );
  }
  model.value = false;
}
</script>

<i18n lang="yaml">
zh:
  createAssignment: 创建作业
  modifyAssignmentInfo: 修改作业信息
  assignmentTitle: 作业标题
  titleRequired: 标题不能为空
  startTime: 开始时间
  dueTime: 提交截止时间
  showScore: 向学生显示分数
  quickActions:
    title: 快速选择
    close1w: 一周后截止
    close2w: 两周后截止
    close1m: 一个月后截止
  weirdDueTime: 截止时间比开始时间早，是否继续？
  success:
    modify: "修改作业“{title}”成功"
    create: "创建作业 {title} 成功"
  fail:
    modify: "修改作业“{title}”失败：{detail}"
    create: "创建作业“{title}”失败：{detail}"
    not_found: 作业不存在
en:
  createAssignment: Create Assignment
  modifyAssignmentInfo: Change Assignment Information
  assignmentTitle: Title
  titleRequired: Title is required
  startTime: Starting at
  dueTime: Closing at
  showScore: Show scores to students
  quickActions:
    title: Quick Actions
    close1w: Close in 1 week
    close2w: Close in 2 weeks
    close1m: Close in 1 month
  weirdDueTime: Closing date is earlier than Starting date, continue?
  success:
    modify: "Assignment “{title}” has been updated."
    create: "Assignment {title} has been created."
  fail:
    modify: "Failed to update “{title}”: {detail}"
    create: "Failed to create assignment “{title}”: {detail}"
    not_found: Assignment not found
</i18n>
