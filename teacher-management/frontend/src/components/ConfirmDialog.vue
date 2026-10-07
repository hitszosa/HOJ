<template>
  <VDialog
    v-bind="dialogProps"
    v-model="isOpen"
    @update:model-value="resolveIfHidden"
    @keydown.esc.stop.prevent="cancel"
  >
    <VCard v-bind="cardProps">
      <component
        :is="titleComponent"
        v-if="titleComponent"
        v-bind="titleComponentProps"
      />
      <VCardTitle v-else v-bind="cardTitleProps">
        {{ title }}
      </VCardTitle>
      <VCardText v-bind="cardTextProps">
        <component
          :is="contentComponent"
          v-if="contentComponent"
          v-bind="contentComponentProps"
        />
        <template v-else>
          <span v-if="content" style="white-space: pre-wrap">
            {{ content }}
          </span>
          <VTextField
            v-if="confirmationKeyword"
            ref="textFieldInput"
            v-model="textField"
            v-bind="confirmationKeywordTextFieldProps"
            variant="underlined"
          />
        </template>
      </VCardText>
      <VCardActions v-bind="cardActionsProps">
        <component
          :is="actionsContentComponent"
          v-if="actionsContentComponent"
          :confirmation-button-disabled="confirmationButtonDisabled"
          :cancel="cancel"
          :confirm="confirm"
        />
        <template v-else>
          <VSpacer />
          <VBtn v-bind="cancellationButtonProps" @click="cancel">
            {{ cancellationText }}
          </VBtn>
          <VBtn
            color="primary"
            :disabled="confirmationButtonDisabled"
            v-bind="confirmationButtonProps"
            @click="confirm"
          >
            {{ confirmationText }}
          </VBtn>
        </template>
      </VCardActions>
    </VCard>
  </VDialog>
</template>

<script setup lang="ts">
import {
  VBtn,
  VCard,
  VCardActions,
  VCardText,
  VDialog,
  VSpacer,
} from "vuetify/components";
import { type Component, computed, nextTick, onMounted, ref } from "vue";

interface Props {
  title?: string;
  titleComponent?: Component;
  titleComponentProps?: object;
  content?: string;
  contentComponent?: Component;
  contentComponentProps?: object;
  confirmationKeyword?: string;
  confirmationKeywordTextFieldProps?: object;
  confirmationText?: string;
  cancellationText?: string;
  dialogProps?: object;
  cardProps?: object;
  cardTitleProps?: object;
  cardTextProps?: object;
  cardActionsProps?: object;
  actionsContentComponent?: object;
  cancellationButtonProps?: object;
  confirmationButtonProps?: object;
  resolve: (value: boolean) => void;
}

const props = withDefaults(defineProps<Props>(), {
  title: "你确定吗？",
  content: "",
  confirmationKeywordTextFieldProps: () => ({}),
  confirmationText: "确定",
  cancellationText: "取消",
  dialogProps: () => ({}),
  cardProps: () => ({}),
  cardTitleProps: () => ({}),
  cardTextProps: () => ({}),
  cardActionsProps: () => ({}),
  cancellationButtonProps: () => ({}),
  confirmationButtonProps: () => ({}),
});

const isOpen = ref(true);
const textFieldInput = ref<HTMLInputElement | null>(null);
const textField = ref("");

function confirm() {
  props.resolve(true);
  isOpen.value = false;
}

function cancel() {
  props.resolve(false);
  isOpen.value = false;
}

onMounted(() => {
  textFieldInput.value?.focus();
});

const confirmationButtonDisabled = computed(() => {
  if (!props.confirmationKeyword) return false;

  return props.confirmationKeyword !== textField.value;
});

function resolveIfHidden(v: boolean) {
  if (!v) {
    nextTick(() => {
      props.resolve(false);
    });
  }
}
</script>
