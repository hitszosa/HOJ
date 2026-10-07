<template>
  <v-container>
    <h2 class="text-headline-large mt-6 mb-3">编辑站点公告</h2>

    <v-card class="pa-4" v-if="announcement">
      <v-form @submit.prevent="submit(false)">
        <v-row>
          <v-col cols="12">
            <v-switch
              v-model="announcement.enable"
              label="启用公告"
              color="primary"
              hide-details
            />
          </v-col>

          <template v-if="announcement.enable">
            <v-col cols="12">
              <p>站点公告是向所有用户于登录后显示的信息。</p>
              <p>
                用户可选择「不再提示」，但只对同一浏览器有效，若用户更换浏览器/设备将再次显示。
              </p>
            </v-col>
            <v-col cols="12" md="6">
              <DateTimePicker
                label="有效时间至"
                v-model="announcement.effective_until"
                ref="effectiveDatePickerRef"
              />
              <span class="mx-2">
                <v-btn rounded size="small" @click="setDeltaEffectiveTime(7)">
                  七天
                </v-btn>
              </span>
              <span class="mx-2">
                <v-btn rounded size="small" @click="setDeltaEffectiveTime(180)">
                  半年
                </v-btn>
              </span>
              <span class="mx-2">
                <v-btn rounded size="small" @click="setDeltaEffectiveTime(21915)">
                  永久
                </v-btn>
              </span>
            </v-col>

            <v-col cols="12" md="6">
              <v-select
                v-model="announcement.display"
                :items="displayOptions"
                label="显示方式"
                required
              />
            </v-col>

            <v-col cols="12" v-if="announcement.display !== 'snack'">
              <v-text-field v-model="announcement.title.zh" label="标题" />
            </v-col>

            <v-col cols="12">
              <v-textarea v-model="announcement.content.zh" label="内容" rows="6" />
            </v-col>
            <v-col cols="12" v-if="announcement.display !== 'snack'">
              <v-text-field v-model="announcement.title.en" label="标题（英文）" />
            </v-col>

            <v-col cols="12">
              <v-textarea
                v-model="announcement.content.en"
                label="内容（英文）"
                rows="6"
              />
            </v-col>
          </template>
        </v-row>
      </v-form>
      <v-card-actions v-if="announcement.enable">
        <v-spacer />
        <v-tooltip
          :open-on-hover="false"
          open-on-click
          :persistent="false"
          location="start"
        >
          <template #activator="{ props }">
            <v-btn v-bind="props" icon="mdi-help-circle-outline" size="small" />
          </template>
          <span>选「修改」时，更新的内容不会向已经读过公告的用户显示。</span>
        </v-tooltip>

        <v-btn
          color="primary"
          variant="tonal"
          prepend-icon="mdi-content-save"
          @click="() => submit(false)"
        >
          修改
        </v-btn>

        <v-btn
          color="secondary"
          variant="tonal"
          prepend-icon="mdi-bell-alert"
          @click="() => submit(true)"
        >
          发布为新公告
        </v-btn>
      </v-card-actions>
    </v-card>

    <v-progress-circular v-else indeterminate />
  </v-container>
</template>

<script setup lang="ts">
import { ApiGetAnnouncement, ApiUpdateAnnouncement } from "@/api/manage";
import { SiteAnnouncement } from "@/api/manage";
import { useAppStore } from "@/stores/app";
import DateTimePicker from "@/components/DateTimePicker.vue";
import { addDays } from "date-fns";
import { getGeneralErrorMsg } from "@/utils/error";

type AnnouncementInfo = Omit<SiteAnnouncement, "publish_date" | "effective_until"> & {
  publish_date: Date;
  effective_until: Date;
};

const DEFAULT_ANNOUNCEMENT: AnnouncementInfo = {
  enable: false,
  publish_date: new Date(),
  effective_until: addDays(new Date(), 7),
  display: "snack",
  title: { zh: "公告", en: "Announcement" },
  content: { zh: "欢迎使用 HITSZ Grader 2！", en: "Welcome to HITSZ Grader 2!" },
};

const announcement = ref<AnnouncementInfo>(DEFAULT_ANNOUNCEMENT);
const { sendSnack } = useAppStore();
const effectiveDatePickerRef: Ref<InstanceType<typeof DateTimePicker> | null> = ref(null);

const displayOptions = [
  { title: "Snack（底部横幅条）", value: "snack" },
  { title: "弹窗（点击外部可关闭）", value: "dialog" },
  { title: "弹窗", value: "dialogPersistent" },
];

onActivated(async () => {
  try {
    const { data } = await ApiGetAnnouncement();
    announcement.value =
      data == null
        ? DEFAULT_ANNOUNCEMENT
        : {
            ...data,
            publish_date: new Date(data.publish_date),
            effective_until: new Date(data.effective_until),
          };
  } catch (error: any) {
    sendSnack("获取公告失败：" + getGeneralErrorMsg(error), "error");
  }
});

watch(
  () => announcement.value.enable,
  (newEnable, oldEnable) =>
    !newEnable &&
    oldEnable &&
    ApiUpdateAnnouncement({
      ...announcement.value,
      enable: false,
      effective_until: announcement.value.effective_until.toISOString(),
      publish_date: announcement.value.publish_date.toISOString(),
    }),
  { immediate: false },
);

function setDeltaEffectiveTime(days: number) {
  effectiveDatePickerRef.value?.setNewValue(addDays(new Date(), days));
}

async function submit(isNew: boolean = false) {
  if (!announcement.value) return;

  try {
    const payload = {
      ...announcement.value,
      effective_until: announcement.value.effective_until.toISOString(),
      publish_date: (isNew ? new Date() : announcement.value.publish_date).toISOString(),
    };

    await ApiUpdateAnnouncement(payload);
    sendSnack(`公告${isNew ? "发布" : "更新"}成功`, "success");
  } catch (error: any) {
    sendSnack(`操作失败：${getGeneralErrorMsg(error)}`, "error");
  }
}
</script>

<route lang="yaml">
name: admin-announcement
meta:
  layout: admin
  title: "站点公告"
</route>
