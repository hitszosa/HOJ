/// confirm.ts
// 此 util 提供方便地动态创建对话框，并返回确认结果的能力。
// This util is heavily inspired by:
// https://github.com/wobsoriano/vuetify-use-dialog/tree/main

import { createVNode, render } from "vue";
import type { AllowedComponentProps, App, Component, VNode, VNodeProps } from "vue";
import { defu } from "defu";
import type {
  VBtn,
  VCard,
  VCardActions,
  VCardText,
  VCardTitle,
  VDialog,
  VTextField,
} from "vuetify/components";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import i18n from "@/plugins/i18n"

type ExtractProps<TComponent> = TComponent extends new () => {
  $props: infer P;
}
  ? Omit<P, keyof VNodeProps | keyof AllowedComponentProps>
  : never;

export interface ConfirmDialogOptions {
  title?: string | null;
  titleComponent?: Component;
  titleComponentProps?: Record<string, any>;
  content?: string;
  contentComponent?: Component;
  contentComponentProps?: Record<string, any>;
  confirmationText?: string;
  cancellationText?: string;
  dialogProps?: ExtractProps<typeof VDialog>;
  cardProps?: ExtractProps<typeof VCard>;
  cardTitleProps?: ExtractProps<typeof VCardTitle>;
  cardTextProps?: ExtractProps<typeof VCardText>;
  cardActionsProps?: ExtractProps<typeof VCardActions>;
  cancellationButtonProps?: ExtractProps<typeof VBtn> & { style: any };
  confirmationButtonProps?: ExtractProps<typeof VBtn>;
  confirmationKeyword?: string;
  confirmationKeywordTextFieldProps?: ExtractProps<typeof VTextField>;
  theme?: string;
  /**
   * @internal
   */
  resolve?: (value: boolean) => void;
}

export function useConfirm() {
  const app = getCurrentInstance()?.appContext.app;
  const { t } = i18n.global;

  async function createConfirm(options: ConfirmDialogOptions) {
    if (!app) throw new Error("Missing vue app instance!");

    const confirmDialogDefaultOptions = {
      title: t("dialog.title"),
      confirmationText: t("dialog.confirm"),
      confirmationButtonProps: {
        variant: "tonal",
      } as ExtractProps<typeof VBtn>,
      cancellationText: t("dialog.cancel"),
      dialogProps: {
        persistent: true,
        maxWidth: 400,
      },
      cardProps: { class: "py-1" } as ExtractProps<typeof VCard>,
    };

    const confirmed = await new Promise<boolean>((resolve) => {
      mount(
        ConfirmDialog,
        defu({ resolve }, options, confirmDialogDefaultOptions ?? {}),
        app,
      );
    });
    render(null, app._container.firstElementChild);
    return confirmed;
  }

  return createConfirm;
}

function mount(component: Component, props: ConfirmDialogOptions, app: App) {
  const vNode: VNode | null = createVNode(component, { ...props });
  if (app?._context) vNode.appContext = app._context;
  render(vNode, app._container.firstElementChild);
  return { vNode };
}
