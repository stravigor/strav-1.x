<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{ start?: number }>()
// biome-ignore lint/correctness/noUnusedVariables: bound by the <template> below
const count = ref(props.start ?? 0)
</script>

<template>
  <button @click="count++">Count is {{ count }}</button>
</template>
