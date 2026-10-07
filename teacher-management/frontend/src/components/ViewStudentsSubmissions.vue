<template>
  <v-skeleton-loader type="card">
    <v-container>
      <v-card class="my-2">
        <v-card-text>
          <v-row density="compact">
            <v-col cols="12" sm="6" md="3">
              {{ t("submission.studentName") }}{{ submission?.user?.real_name }}
            </v-col>
            <v-col cols="12" sm="6" md="2" v-if="submission?.score != null">
              {{ t("submission.totalScore") }}{{ submission.score }}
            </v-col>
            <v-col
              cols="12"
              sm="6"
              md="3"
              :class="submission?.status === 1 ? 'text-green' : 'text-red'"
            >
              {{ t("status.label")
              }}{{ submission?.status ? t("graded") : t("notGraded") }}
            </v-col>
            <v-col cols="auto">
              {{ t("submission.submitTime") }}{{ FormatDate(submission?.submit_time) }}
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>
      <v-row>
        <v-col class="flex-grow-1">
          <QuestionTemplate
            :assignment
            :disable="true"
            :last-submission="submission"
            :result="submission.score"
            :view-result="false"
          >
            <template #title>
              <div class="d-flex align-center">
                <v-chip
                  color="pink-lighten-1"
                  class="me-2"
                  v-if="submission.status === 0"
                  :text="t('notGraded')"
                />
                <v-chip
                  v-if="submission.status === 1"
                  :color="(submission.score ? 'green' : 'orange') + `-lighten-1`"
                  class="me-2"
                  :prepend-icon="
                    submission.score ? 'mdi-checkbox-marked-circle' : 'mdi-close-circle'
                  "
                >
                  {{
                    t("submission.currentScore", {
                      score: submission.score,
                      total: assignment.score,
                    })
                  }}
                </v-chip>
                <h3 class="text-headline-small my-2">{{ t("assignment.question") }}</h3>
              </div>
            </template>
          </QuestionTemplate>
        </v-col>
        <v-col cols="12" sm="4">
          <v-card>
            <v-card-title tag="h3" class="text-headline-small my-2">
              {{ t("grading.updateScore") }}
            </v-card-title>
            <v-card-text>
              <v-chip color="blue">
                {{ t("assignment.totalScore", { score: assignment.score }) }}
              </v-chip>
              <v-form ref="scoreForm" validate-on="blur lazy" @submit.prevent>
                <v-text-field
                  :placeholder="t('grading.scorePlaceholder')"
                  v-model="newScore"
                  type="number"
                  density="comfortable"
                  class="my-2"
                  :rules="[
                    (v: string) => !!v || t('validation.required'),
                    (v: string) => /^[0-9]+$/.test(v) || t('validation.integerOnly'),
                    (v: string) =>
                      parseInt(v) <= assignment.score ||
                      t('validation.maxScore', { maxScore: assignment.score }),
                  ]"
                  @keydown.enter="updateScore"
                />
              </v-form>
            </v-card-text>
            <v-card-actions>
              <v-spacer />
              <v-btn
                color="primary"
                variant="tonal"
                @click="updateScore"
                append-icon="mdi-arrow-up-bold"
                :text="t('button.update')"
              />
            </v-card-actions>
          </v-card>
          <v-col />
        </v-col>
      </v-row>
    </v-container>
  </v-skeleton-loader>
  <Fab
    app
    color="green"
    size="x-large"
    :disabled="noNext"
    @click="emit('next')"
    :text="t('button.next')"
    append-icon="mdi-arrow-right"
  />
</template>

<script setup lang="ts">
import { Assignment, Submission } from "@/api/course";
import { ApiUpdateScore, FormatDate } from "@/api/course";
import { useAppStore } from "@/stores/app";
import type { VForm } from "vuetify/components";
import { useI18n } from "vue-i18n";
import { getGeneralErrorMsg } from "@/utils/error";

const props = defineProps<{
  submission: Submission;
  assignment: Assignment;
  noNext: boolean;
}>();

const emit = defineEmits<{
  (e: "next"): void;
  (e: "score-updated", payload: { submissionId: number; score: number }): void;
}>();

const { sendSnack } = useAppStore();
const { t } = useI18n();

// Component State
const scoreForm = ref(null as null | VForm);

// Data
const newScore = ref("0");

watch(
  () => props.submission.score,
  (v) => (newScore.value = String(v ?? 0)),
  { immediate: true },
);

async function updateScore() {
  if (!scoreForm.value || !(await scoreForm.value?.validate()).valid) return;

  try {
    const resp = await ApiUpdateScore(
      props.submission.id,
      parseInt(newScore.value, 10),
    );
    emit("score-updated", {
      submissionId: props.submission.id,
      score: resp.data.score,
    });

    sendSnack(t("success.update"), "success");
  } catch (error: any) {
    sendSnack(t("error.update", { error: getGeneralErrorMsg(error) }), "warning");
  }
}
</script>

<i18n lang="yaml">
zh:
  submission:
    studentName: 学生名字：
    totalScore: 总得分：
    submitTime: 提交时间：
    currentScore: "得分：{score} / {total}"
  status:
    label: 状态：
  grading:
    updateScore: 修改评分
    scorePlaceholder: 请输入新分数
  assignment:
    totalScore: 总分：{score}
    question: 题目
  button:
    update: 更新
    next: 下一份
  validation:
    required: 必须输入分数
    integerOnly: 请输入整数形式的分数
    maxScore: "分数不得高于作业总分（{maxScore}）！"
  success:
    update: 更新成功
  error:
    update: "更新失败：{error}"

en:
  submission:
    studentName: "Student Name: "
    totalScore: "Total Score: "
    submitTime: "Submission Time: "
    currentScore: "Score: {score}/{total}"
  status:
    label: "Status: "
  grading:
    updateScore: Update Score
    scorePlaceholder: Enter new score
  assignment:
    totalScore: "Total: {score}"
    question: Problem
  button:
    update: Update
    next: Next
  validation:
    required: Score is required
    integerOnly: Must be an integer
    maxScore: "Score cannot exceed {maxScore}!"
  success:
    update: Score updated
  error:
    update: "Update failed: {error}"
</i18n>
