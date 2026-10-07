<template>
  <div style="height: 4px">
    <!-- 定高占位 -->
    <v-progress-linear
      v-if="show"
      v-model="dueTimePassedPercent"
      :buffer-value="dueTimeAfterOneDayPercent"
      :color="muted ? 'grey-lighten-1' : dueTimeColor"
      :stream="isValid"
      :striped="isValid"
      height="4"
      rounded
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { getDueTimeColor, parseDate } from "@/utils/assignments";

interface Props {
  startTime: string | Date;
  dueTime: string | Date;
  disabled?: boolean;
  show?: boolean;
  muted?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  show: true,
  muted: false,
});

const startTime = computed(() => parseDate(props.startTime));
const dueTime = computed(() => parseDate(props.dueTime));

const isValid = computed(() => {
  if (props.disabled) {
    return false;
  }
  const now = new Date();
  return startTime.value <= now && now <= dueTime.value;
});

/** 返回计时进度，已过去时间 / 总开放时间 * 100
 *  如 72.00
 */
const dueTimePassedPercent = computed(() => {
  if (!isValid.value) {
    return 100;
  }
  const now = Date.now();
  if (now > dueTime.value.getTime()) {
    return 100;
  }
  const openTime = dueTime.value.getTime() - startTime.value.getTime();
  const passedTime = now - startTime.value.getTime();
  return (passedTime / openTime) * 100;
});

/** 向后推演 1 天后的计时进度
 */
const dueTimeAfterOneDayPercent = computed(() => {
  const openTime = dueTime.value.getTime() - startTime.value.getTime();
  return dueTimePassedPercent.value + ((86400 * 1000) / openTime) * 100;
});

const dueTimeColor = computed(() => getDueTimeColor(dueTime.value, !isValid.value));
</script>

<style scoped></style>
