<template>
  <view class="content">
    <image class="logo" :src="imgPath" />
    <view class="text-area">
      <text class="title">--??--{{ title }}</text>
    </view>
    <u-button @click="handleClickZPageDemo">zPageDemo</u-button>
    <Tree style="width: 100%" />
  </view>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { test } from "@/utils/test";
import { api } from "@/utils/api";
// import { api } from "@root/src/js/api";

import Tree from "@/components/tree/Demo.vue";

import imgPath from "@/static/logo.png";
test("imgPath--", imgPath);

const title = ref("Hello----？？1？2?34--68-991--");
console.log("root api js ----", api);

const handleClickZPageDemo = () => {
  const route = {
    url: "/vue3-module/pages/demo/ZPaging",
  };

  console.log("handleClickZPageDemo -- ", route);

  uni.navigateTo(route);
};
</script>

<style>
.content {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  width: 100%;
}

.logo {
  height: 200rpx;
  width: 200rpx;
  margin-top: 200rpx;
  margin-left: auto;
  margin-right: auto;
  margin-bottom: 50rpx;
}

.text-area {
  display: flex;
  justify-content: center;
}

.title {
  font-size: 36rpx;
  color: #8f8f94;
}
</style>
