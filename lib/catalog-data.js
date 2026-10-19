/**
 * Cline Pass model metadata, snapshotted from models.dev's `cline-pass`
 * provider on 2026-10-19 and reconciled with the shipped dsh-cline-pass table.
 *
 * Keys are the gateway's API ids. `contextWindow` / `maxTokens` are the
 * published caps, not preferences; `input` is the input modality list the
 * catalog declares (magpie's model shape takes booleans built from it).
 * `efforts` is the reasoning vocabulary that model actually answers to; a
 * null list means the catalog named none, and the caller keeps the full one.
 */
export const MODEL_CATALOG = {
  "cline-pass/deepseek-v4.1-flash-1017": {
    "name": "DeepSeek V4.1 Flash 1017",
    "contextWindow": 1048576,
    "maxTokens": 384000,
    "reasoning": true,
    "efforts": [
      "none",
      "low",
      "high",
      "max"
    ],
    "input": [
      "text",
      "image"
    ]
  },
  "cline-pass/deepseek-v4.1-flash": {
    "name": "DeepSeek V4.1 Flash",
    "contextWindow": 1000000,
    "maxTokens": 384000,
    "reasoning": true,
    "efforts": [
      "none",
      "low",
      "high",
      "max"
    ],
    "input": [
      "text",
      "image"
    ]
  },
  "cline-pass/mimo-v2.6-flash": {
    "name": "MiMo-V2.6-Flash",
    "contextWindow": 1048576,
    "maxTokens": 131072,
    "reasoning": true,
    "efforts": null,
    "input": [
      "text",
      "image",
      "audio",
      "video"
    ]
  },
  "cline-pass/mimo-v2.6-pro": {
    "name": "MiMo-V2.6-Pro",
    "contextWindow": 1048576,
    "maxTokens": 131072,
    "reasoning": true,
    "efforts": null,
    "input": [
      "text",
      "image",
      "audio",
      "video"
    ]
  },
  "cline-pass/glm-5.3": {
    "name": "GLM-5.3",
    "contextWindow": 1000000,
    "maxTokens": 131072,
    "reasoning": true,
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "input": [
      "text"
    ]
  },
  "cline-pass/deepseek-v4-pro": {
    "name": "DeepSeek V4 Pro",
    "contextWindow": 1000000,
    "maxTokens": 384000,
    "reasoning": true,
    "efforts": [
      "none",
      "low",
      "high",
      "max"
    ],
    "input": [
      "text"
    ]
  },
  "cline-pass/qwen3.8-max": {
    "name": "Qwen3.8 Max",
    "contextWindow": 1000000,
    "maxTokens": 131072,
    "reasoning": true,
    "efforts": [
      "none",
      "low",
      "medium",
      "xhigh"
    ],
    "input": [
      "text",
      "image",
      "video",
      "pdf"
    ]
  },
  "cline-pass/muse-spark-1.3-contributor": {
    "name": "Muse Spark 1.3 Contributor",
    "contextWindow": 1048576,
    "maxTokens": 131072,
    "reasoning": true,
    "efforts": null,
    "input": [
      "text",
      "image",
      "video",
      "pdf",
      "audio"
    ]
  },
  "cline-pass/kimi-k3": {
    "name": "Kimi K3",
    "contextWindow": 1048576,
    "maxTokens": 131072,
    "reasoning": true,
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "input": [
      "text",
      "image",
      "video"
    ]
  },
  "cline-pass/glm-5.3-flash": {
    "name": "GLM 5.3 Flash",
    "contextWindow": 1000000,
    "maxTokens": 131072,
    "reasoning": true,
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "input": [
      "text",
      "image",
      "video",
      "pdf"
    ]
  },
  "cline-pass/qwen3.7-max": {
    "name": "Qwen3.7 Max",
    "contextWindow": 1000000,
    "maxTokens": 65536,
    "reasoning": true,
    "efforts": null,
    "input": [
      "text"
    ]
  },
  "cline-pass/minimax-m3": {
    "name": "MiniMax-M3",
    "contextWindow": 1048576,
    "maxTokens": 512000,
    "reasoning": true,
    "efforts": null,
    "input": [
      "text",
      "image",
      "video"
    ]
  },
  "cline-pass/qwen3.7-plus": {
    "name": "Qwen3.7 Plus",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "reasoning": true,
    "efforts": null,
    "input": [
      "text",
      "image",
      "video"
    ]
  },
  "cline-pass/mimo-v2.5-pro": {
    "name": "MiMo-V2.5-Pro",
    "contextWindow": 1048576,
    "maxTokens": 131072,
    "reasoning": true,
    "efforts": null,
    "input": [
      "text"
    ]
  },
  "cline-pass/mimo-v2.5": {
    "name": "MiMo-V2.5",
    "contextWindow": 1048576,
    "maxTokens": 131072,
    "reasoning": true,
    "efforts": null,
    "input": [
      "text",
      "image",
      "audio",
      "video"
    ]
  },
  "cline-pass/glm-5.2": {
    "name": "GLM-5.2",
    "contextWindow": 1000000,
    "maxTokens": 131072,
    "reasoning": true,
    "efforts": [
      "none",
      "high",
      "max"
    ],
    "input": [
      "text"
    ]
  },
  "cline-pass/kimi-k2.7-code": {
    "name": "Kimi K2.7 Code",
    "contextWindow": 262144,
    "maxTokens": 262144,
    "reasoning": true,
    "efforts": [
      "none",
      "low",
      "medium",
      "high"
    ],
    "input": [
      "text",
      "image",
      "video"
    ]
  },
  "cline-pass/kimi-k2.6": {
    "name": "Kimi K2.6",
    "contextWindow": 262144,
    "maxTokens": 262144,
    "reasoning": true,
    "efforts": null,
    "input": [
      "text",
      "image",
      "video"
    ]
  },
  "cline-pass/deepseek-v4-flash": {
    "name": "DeepSeek V4 Flash",
    "contextWindow": 1000000,
    "maxTokens": 384000,
    "reasoning": true,
    "efforts": [
      "none",
      "low",
      "medium",
      "high"
    ],
    "input": [
      "text"
    ]
  }
};

/** Selectable reasoning efforts, in escalating order. */
export const REASONING_EFFORTS = [
  { id: "none", name: "None", description: "No extra thinking; fastest and cheapest." },
  { id: "minimal", name: "Minimal", description: "A bare minimum of reasoning." },
  { id: "low", name: "Low", description: "Prefer for routine or latency-sensitive work." },
  { id: "medium", name: "Medium", description: "A balanced amount of reasoning." },
  { id: "high", name: "High", description: "More thorough reasoning for multi-step work." },
  { id: "xhigh", name: "Extra high", description: "For difficult work that rewards more thinking." },
  { id: "max", name: "Max", description: "Reserve for the hardest quality-first tasks." },
];
