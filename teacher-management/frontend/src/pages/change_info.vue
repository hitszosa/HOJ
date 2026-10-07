<template>
  <v-container>
    <h2 class="my-4 text-headline-large font-weight-light">{{ t("myAccount") }}</h2>
    <v-row>
      <v-col cols="12" sm="6" lg="5">
        <MyProfileCard />
      </v-col>
      <v-col cols="12" sm="6" lg="5">
        <v-card>
          <v-card-title class="my-2" tag="h3">{{ t("changePass.title") }}</v-card-title>
          <v-card-text>
            <v-form ref="form" validate-on="submit lazy">
              <v-text-field
                v-model="oldPassword"
                :label="t('changePass.oldPass')"
                :rules="[(v: string) => !!v || t('changePass.required')]"
                type="password"
                variant="underlined"
              />
              <v-text-field
                v-model="newPassword"
                :label="t('changePass.newPass')"
                :rules="[(v: string) => !!v || t('changePass.required')]"
                type="password"
                variant="underlined"
              />
              <v-text-field
                v-model="confirmPassword"
                :label="t('changePass.newPassAgain')"
                :rules="[
                  (v: string) => v === newPassword || t('changePass.dontMatch'),
                  (v) =>
                    !(v === newPassword && v === '') ||
                    t('changePass.suggest.UseAFewWordsAvoidCommonPhrases') +
                      t('changePass.suggest.NoNeedForSymbolsDigitsOrUppercaseLetters'),
                ]"
                type="password"
                variant="underlined"
              />
            </v-form>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn @click="changePassword"> {{ t("changePass.save") }} </v-btn>
          </v-card-actions>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { VForm } from "vuetify/components";
import { ApiChangePassword } from "@/api/user";
import { useAppStore } from "@/stores/app";
import { useI18n } from "vue-i18n";
import { AxiosError } from "axios";
import { BackendError } from "@/api/axiosInstance";
import { getGeneralErrorMsg } from "@/utils/error";

const { t } = useI18n();
const { sendSnack } = useAppStore();

const newPassword = ref("");
const oldPassword = ref("");
const confirmPassword = ref("");

const form: Ref<VForm | null> = ref(null);

function getWeakPwdMsg(backendMsg: string) {
  // 解析错误消息
  // 来自：https://github.com/shssoichiro/zxcvbn-rs/blob/38410db8a6436f97cba2afbfc0a09e2b8255f4b7/src/feedback.rs

  const warningList = [
    "StraightRowsOfKeysAreEasyToGuess",
    "ShortKeyboardPatternsAreEasyToGuess",
    "RepeatsLikeAaaAreEasyToGuess",
    "RepeatsLikeAbcAbcAreOnlySlightlyHarderToGuess",
    "ThisIsATop10Password",
    "ThisIsATop100Password",
    "ThisIsACommonPassword",
    "ThisIsSimilarToACommonlyUsedPassword",
    "SequencesLikeAbcAreEasyToGuess",
    "RecentYearsAreEasyToGuess",
    "AWordByItselfIsEasyToGuess",
    "DatesAreOftenEasyToGuess",
    "NamesAndSurnamesByThemselvesAreEasyToGuess",
    "CommonNamesAndSurnamesAreEasyToGuess",
  ];
  const suggestionList = [
    "UseAFewWordsAvoidCommonPhrases",
    "NoNeedForSymbolsDigitsOrUppercaseLetters",
    "AddAnotherWordOrTwo",
    "CapitalizationDoesntHelpVeryMuch",
    "AllUppercaseIsAlmostAsEasyToGuessAsAllLowercase",
    "ReversedWordsArentMuchHarderToGuess",
    "PredictableSubstitutionsDontHelpVeryMuch",
    "UseALongerKeyboardPatternWithMoreTurns",
    "AvoidRepeatedWordsAndCharacters",
    "AvoidSequences",
    "AvoidRecentYears",
    "AvoidYearsThatAreAssociatedWithYou",
    "AvoidDatesAndYearsThatAreAssociatedWithYou",
  ];
  const warnings = warningList
    .filter((word) => backendMsg.includes(word))
    .map((k) => t(`changePass.warn.${k}`));
  const suggestions = suggestionList
    .filter((word) => backendMsg.includes(word))
    .map((k) => t(`changePass.suggest.${k}`));
  return t("changePass.weak") + warnings.join("") + "\n" + suggestions.join("");
}

async function changePassword() {
  if (!form.value) return;
  if (!(await form.value.validate()).valid) return;

  try {
    await ApiChangePassword(oldPassword.value, newPassword.value);
    sendSnack(t("changePass.success"), "success");
    form.value.reset();
    await fetch("/api/session", { method: "DELETE" });
    window.location.assign("/management/login");
  } catch (error: any) {
    const e: AxiosError<BackendError> = error;
    const kind = e?.response?.data.error;
    if (kind === "authentication_error") {
      sendSnack(t("changePass.wrong"), "warning");
    } else if (e.response?.data.message.includes("weak")) {
      sendSnack(getWeakPwdMsg(e.response.data.message), "warning");
    } else {
      sendSnack(getGeneralErrorMsg(error), "warning");
    }
  }
}
</script>

<route lang="yaml">
name: change-user-info
meta:
  title: 账号信息
  titleEn: My Account
</route>

<i18n lang="yaml">
zh:
  myAccount: 修改用户信息
  changePass:
    title: 修改密码
    oldPass: 旧的密码
    newPass: 新的密码
    newPassAgain: 确认密码
    save: 确认修改
    required: 密码不得为空
    dontMatch: 两次密码不一致
    success: 修改密码成功，请使用新密码重新登录。
    wrong: 旧的密码有误！
    weak: "您的密码太弱了，请换一个。\n"
    req:
      long: 密码长度至少应为 8 个字符。
      upper: 密码须包含至少一个大写字母。
      lower: 密码须包含至少一个小写字母。
      number: 密码须包含至少一个数字。
      different: 新旧密码不得相同。
    warn:
      StraightRowsOfKeysAreEasyToGuess: 键盘上的直线排列很容易被猜到哦。
      ShortKeyboardPatternsAreEasyToGuess: 键盘上的排列很容易被猜到哦。
      RepeatsLikeAaaAreEasyToGuess: 重复的字符很容易被猜到哦。
      RepeatsLikeAbcAbcAreOnlySlightlyHarderToGuess: 重复的字符串很容易被猜到哦。
      ThisIsATop10Password: 这个密码太常见了。
      ThisIsATop100Password: 这个密码太常见了。
      ThisIsACommonPassword: 这个密码太常见了。
      ThisIsSimilarToACommonlyUsedPassword: 这个密码跟某个常见密码太像了。
      SequencesLikeAbcAreEasyToGuess: 连续的字符很容易被猜到哦。
      RecentYearsAreEasyToGuess: 年份很容易被猜到哦。
      AWordByItselfIsEasyToGuess: 单个单词很容易被猜到哦。
      DatesAreOftenEasyToGuess: 日期很容易被猜到哦。
      NamesAndSurnamesByThemselvesAreEasyToGuess: 单个姓氏名字很容易被猜到哦。
      CommonNamesAndSurnamesAreEasyToGuess: 常见的姓氏名字很容易被猜到哦。
    suggest:
      UseAFewWordsAvoidCommonPhrases: 试试用几个字词来组合呢。最好不要用常见的短语。
      NoNeedForSymbolsDigitsOrUppercaseLetters: 符号、数字或大写字母不是必需的。
      AddAnotherWordOrTwo: 试试再加几个字词呢。
      CapitalizationDoesntHelpVeryMuch: 大写也不一定能提供太多保护呢。
      AllUppercaseIsAlmostAsEasyToGuessAsAllLowercase: 全大写和全小写一样容易被猜到哦。
      ReversedWordsArentMuchHarderToGuess: 反转也不一定能提供太多保护呢。
      PredictableSubstitutionsDontHelpVeryMuch: 有规律的字符替换也不一定能提供太多保护呢。
      UseALongerKeyboardPatternWithMoreTurns: 试试使用更长的键盘序列，并加点转折呢。
      AvoidRepeatedWordsAndCharacters: 最好不要用重复的字词。
      AvoidSequences: 最好不要用连续的字符。
      AvoidRecentYears: 最好不要用近期年份。
      AvoidYearsThatAreAssociatedWithYou: 最好不要用跟你有关的年份。
      AvoidDatesAndYearsThatAreAssociatedWithYou: 最好不要用跟你有关的日期。
en:
  myAccount: My Account
  changePass:
    title: Change Password
    oldPass: Old Password
    newPass: New Password
    newPassAgain: New Password Again
    save: Save
    required: This field is required.
    dontMatch: These passwords don't match.
    success: Your password has been updated. Sign in again with your new password.
    wrong: Old password is incorrect. Please try again.
    weak: "Your password does not meet the security requirements. Try another one.\n"
    req:
      long: "Password must be at least 8 characters long. "
      upper: "Password must contain at least one uppercase letter. "
      lower: "Password must contain at least one lowercase letter. "
      number: "Password must contain at least one number. "
      different: "New password must be different from the old one. "
    warn:
      StraightRowsOfKeysAreEasyToGuess: "Straight rows of keys are easy to guess. "
      ShortKeyboardPatternsAreEasyToGuess: "Short keyboard patterns are easy to guess. "
      RepeatsLikeAaaAreEasyToGuess: "Repeats like 'aaa' are easy to guess. "
      RepeatsLikeAbcAbcAreOnlySlightlyHarderToGuess: "Repeats like 'abcabc' are only slightly harder to guess. "
      ThisIsATop10Password: "This is a top-10 common password. "
      ThisIsATop100Password: "This is a top-100 common password. "
      ThisIsACommonPassword: "This is a very common password. "
      ThisIsSimilarToACommonlyUsedPassword: "This is similar to a commonly used password. "
      SequencesLikeAbcAreEasyToGuess: "Sequences like 'abc' are easy to guess. "
      RecentYearsAreEasyToGuess: "Recent years are easy to guess. "
      AWordByItselfIsEasyToGuess: "A word by itself is easy to guess. "
      DatesAreOftenEasyToGuess: "Dates are often easy to guess. "
      NamesAndSurnamesByThemselvesAreEasyToGuess: "Names and surnames by themselves are easy to guess. "
      CommonNamesAndSurnamesAreEasyToGuess: "Common names and surnames are easy to guess. "
    suggest:
      UseAFewWordsAvoidCommonPhrases: "Use a few words, avoid common phrases. "
      NoNeedForSymbolsDigitsOrUppercaseLetters: "No need for symbols, digits, or uppercase letters. "
      AddAnotherWordOrTwo: "Add another word or two. Uncommon words are better. "
      CapitalizationDoesntHelpVeryMuch: "Capitalization doesn't help very much. "
      AllUppercaseIsAlmostAsEasyToGuessAsAllLowercase: "All-uppercase is almost as easy to guess as all-lowercase. "
      ReversedWordsArentMuchHarderToGuess: "Reversed words aren't much harder to guess. "
      PredictableSubstitutionsDontHelpVeryMuch: "Predictable substitutions don't help very much. "
      UseALongerKeyboardPatternWithMoreTurns: "Use a longer keyboard pattern with more turns. "
      AvoidRepeatedWordsAndCharacters: "Avoid repeated words and characters. "
      AvoidSequences: "Avoid sequences. "
      AvoidRecentYears: "Avoid recent years. "
      AvoidYearsThatAreAssociatedWithYou: "Avoid years that are associated with you. "
      AvoidDatesAndYearsThatAreAssociatedWithYou: "Avoid dates and years that are associated with you. "
</i18n>
