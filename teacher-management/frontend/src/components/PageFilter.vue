<template>
  <div ref="container" class="page-filter">
    <v-text-field
      :model-value="model"
      :label="label"
      :aria-label="label"
      aria-keyshortcuts="/"
      prepend-inner-icon="mdi-magnify"
      variant="outlined"
      density="compact"
      hide-details
      clearable
      @update:model-value="model = $event ?? ''"
      @keydown.esc="clearOrBlur"
    >
      <template #append-inner>
        <kbd aria-hidden="true" class="text-medium-emphasis">/</kbd>
      </template>
    </v-text-field>
  </div>
</template>

<script setup lang="ts">
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from "vue";

const model = defineModel<string>({ default: "" });
defineProps<{ label: string }>();
const container = ref<HTMLElement>();

function focusFilter(event: KeyboardEvent) {
  if (
    event.key !== "/" ||
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return;
  const editing = event
    .composedPath()
    .some(
      (target) =>
        target instanceof HTMLElement &&
        (target.matches(
          "input, textarea, select, [role='textbox'], [role='combobox'], [role='searchbox']",
        ) ||
          target.isContentEditable),
    );
  if (editing || document.querySelector(".v-dialog.v-overlay--active")) return;
  if (!container.value?.isConnected || !container.value.getClientRects().length) return;
  const input = container.value.querySelector("input");
  if (!input) return;
  event.preventDefault();
  input.focus();
  input.select();
}

function clearOrBlur(event: KeyboardEvent) {
  if (event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  if (model.value) model.value = "";
  else container.value?.querySelector("input")?.blur();
}

const bindShortcut = () => window.addEventListener("keydown", focusFilter);
const unbindShortcut = () => window.removeEventListener("keydown", focusFilter);
onMounted(bindShortcut);
onActivated(bindShortcut);
onDeactivated(unbindShortcut);
onBeforeUnmount(unbindShortcut);
</script>

<style scoped>
.page-filter {
  flex: 0 1 20rem;
  width: 20rem;
  max-width: 100%;
  margin-inline-start: auto;
}

.page-filter kbd {
  padding: 0 6px;
  border: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 4px;
  font: inherit;
}

@media (max-width: 599px) {
  .page-filter {
    flex-basis: 100%;
    width: 100%;
  }
}
</style>
