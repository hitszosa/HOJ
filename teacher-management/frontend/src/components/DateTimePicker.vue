<template>
  <v-menu v-model="showMenu" :close-on-content-click="false" location="right">
    <template #activator="{ props }">
      <v-text-field
        v-model="inputValue"
        v-bind="props"
        :disabled="disabled"
        :label="label"
        type="datetime"
        :loading="loading"
        @update:model-value="handleInput"
        @update:focused="(f) => f || handleBlur()"
        :error="isInvalid"
        :prepend-icon="prependIcon"
      >
        <template #loader>
          <v-progress-linear absolute />
        </template>
      </v-text-field>
    </template>

    <v-card>
      <v-card-text class="pa-0">
        <v-tabs fixed-tabs color="secondary" v-model="activeTab">
          <v-tab key="calendar" prepend-icon="mdi-calendar" :text="t('pickDate')" />
          <v-tab key="timer" prepend-icon="mdi-clock-outline" :text="t('pickTime')" />
        </v-tabs>
        <v-tabs-window v-model="activeTab">
          <v-tabs-window-item key="calendar">
            <v-date-picker
              v-model="date"
              :allowedDates="allowedDates"
              @update:modelValue="showTimePicker"
              show-adjacent-months
            />
          </v-tabs-window-item>
          <v-tabs-window-item key="timer">
            <v-time-picker
              v-model="time"
              format="24hr"
              scrollable
              @update:model-value="combineDatetime"
              v-model:view-mode="timePickerView"
            />
          </v-tabs-window-item>
        </v-tabs-window>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn color="grey-darken-2" @click="clearHandler" :text="t('dialog.cancel')" />
        <v-btn color="primary" variant="tonal" @click="okHandler">
          {{ t("dialog.confirm") }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-menu>
</template>

<script setup lang="ts">
import { format, isSameDay, parse } from "date-fns";
import { VDatePicker } from "vuetify/components";
import { VTimePicker } from "vuetify/components";
import { useDisplay } from "vuetify";
import { useI18n } from "vue-i18n";

interface Props {
  disabled?: boolean;
  label?: string;
  prependIcon?: string;
}

withDefaults(defineProps<Props>(), {
  disabled: false,
});

const datetime = defineModel<Date>({ required: true });

const showMenu = ref(false);
const activeTab = ref(0);
const loading = ref(false);
const timePickerView: Ref<"hour" | "minute"> = ref("hour");

const date = ref(new Date());
const time = ref("00:00");
let original_date = date.value;
let original_time = time.value;

const allowedDates: Ref<undefined | string[]> = ref(undefined);

const { platform } = useDisplay();
const { t } = useI18n();

const inputValue = ref(format(datetime.value, "yyyy-MM-dd HH:mm"));
const isInvalid = ref(false);

onBeforeMount(init);

function updateDateAndTime(dt: Date) {
  // datetime --> date, time
  date.value = dt;
  time.value = format(dt, "HH:mm");
}

function updateState() {
  // datetime --> date, time, inputValue
  updateDateAndTime(datetime.value);
  inputValue.value = format(datetime.value, "yyyy-MM-dd HH:mm");
  isInvalid.value = false;
}

function init() {
  updateState();
  saveAsOriginal();
}

function combineDatetime() {
  // date, time --> datetime, inputValue
  inputValue.value = format(date.value, "yyyy-MM-dd ") + time.value;
  datetime.value = parse(inputValue.value, "yyyy-MM-dd HH:mm", new Date());
}

function saveAsOriginal() {
  original_date = date.value;
  original_time = time.value;
}

function okHandler() {
  // combineDatetime();
  saveAsOriginal();
  showMenu.value = false;
}

function restoreOriginal() {
  date.value = original_date;
  time.value = original_time;
  combineDatetime();
}

function clearHandler() {
  restoreOriginal();
  showMenu.value = false;
}

function showTimePicker() {
  combineDatetime();

  // 在选定日期后，停顿一会（以便能够发现有无点错），再切换到选择时间 tab
  // 此间不许选择其他日期
  allowedDates.value = [format(date.value, "yyyy-MM-dd")];
  setTimeout(
    () => (activeTab.value = 1),
    isSameDay(date.value, original_date) ? 0 : platform.value.touch ? 720 : 360,
  );
}

watch(activeTab, (newActiveTab) => {
  if (newActiveTab === 0) {
    allowedDates.value = undefined;
  }
});

watch(datetime, updateState);

// 每次显示此组件时切换到选择日期 tab
watch(showMenu, (newShowMenu) => {
  if (newShowMenu) {
    activeTab.value = 0;
  }
});

function validateDateTime(value: string) {
  try {
    const parsed = parse(value, "yyyy-MM-dd HH:mm", new Date());
    return { isValid: !isNaN(parsed.getTime()), newDate: parsed };
  } catch {
    return { isValid: false, newDate: null };
  }
}

function updateDateAndTimeInteractive(dt: Date) {
  // datetime --> date, time
  if (!isSameDay(date.value, dt)) {
    activeTab.value = 0;
  }
  date.value = dt;
  const newTime = format(dt, "HH:mm");
  if (time.value !== newTime) {
    activeTab.value = 1;
    if (time.value.slice(0, 2) !== newTime.slice(0, 2)) timePickerView.value = "hour";
    if (time.value.slice(3) !== newTime.slice(3)) timePickerView.value = "minute";

    time.value = newTime;
  }
}

function handleInput(newValue: string) {
  const { isValid, newDate } = validateDateTime(newValue);
  isInvalid.value = !isValid;
  if (isValid && newDate) {
    updateDateAndTimeInteractive(newDate);
  }
}

function handleBlur() {
  const { isValid, newDate: newDate } = validateDateTime(inputValue.value);
  isInvalid.value = !isValid;

  if (isValid && newDate) {
    datetime.value = newDate;
  } else {
    restoreOriginal();
  }
}

function flash() {
  loading.value = true;
  setTimeout(() => (loading.value = false), 200);
}

function setNewValue(dt: Date) {
  datetime.value = dt;
  updateDateAndTime(dt);
  saveAsOriginal();
  // 当由外部改变此组件的 model value 时，示以闪烁
  flash();
}

// 建议外部总是通过此方法改变此组件的 model value 时，以便记录默认值
defineExpose({ setNewValue });
</script>

<style scoped>
/* 不显示 time picker 和 date picker 的标题 */
.v-date-picker :deep(.v-picker-title) {
  display: none;
}
.v-time-picker :deep(.v-picker-title) {
  display: none;
}
</style>

<i18n lang="yaml">
zh:
  pickDate: 选择日期
  pickTime: 选择时间
en:
  pickDate: Date
  pickTime: Time
</i18n>
