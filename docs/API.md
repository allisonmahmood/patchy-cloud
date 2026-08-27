# Patchy Cloud API

<!-- Generated from packages/core/src/wire.ts. Do not edit by hand. -->

Every JSON shape below is generated from the Effect Schema used at runtime by the server and CLI.
API errors use the shared error shape after the route-specific success response.

## HTTP API

### `GET /healthz`

Report whether the instance process is healthy.

Authentication: None.

Success response (200):

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "enum": [
        true
      ]
    }
  },
  "required": [
    "ok"
  ],
  "additionalProperties": false
}
```

### `GET /api/me`

Return the principal and API token represented by the credential.

Authentication: Bearer token.

Success response (200):

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "accountId": {
      "type": "string"
    },
    "accountName": {
      "type": "string"
    },
    "apiTokenId": {
      "type": "string"
    },
    "apiTokenName": {
      "type": "string"
    },
    "scopes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "accountId",
    "accountName",
    "apiTokenId",
    "apiTokenName",
    "scopes"
  ],
  "additionalProperties": false
}
```

### `POST /api/tokens`

Mint an API token for the authenticated principal.

Authentication: Bearer token with admin scope.

Request body:

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string"
    },
    "scopes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "additionalProperties": false
}
```

Success response (201):

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "enum": [
        true
      ]
    },
    "apiToken": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "name": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "name"
      ],
      "additionalProperties": false
    },
    "token": {
      "type": "string"
    }
  },
  "required": [
    "ok",
    "apiToken",
    "token"
  ],
  "additionalProperties": false
}
```

### `POST /api/tokens/self-service`

Mint a self-service principal and its first publishing token.

Authentication: None.

Request body:

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "additionalProperties": false
}
```

Success response (201):

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "enum": [
        true
      ]
    },
    "token": {
      "type": "string"
    }
  },
  "required": [
    "ok",
    "token"
  ],
  "additionalProperties": false
}
```

### `POST /api/tokens/:apiTokenId/revoke`

Revoke an API token without deleting its record.

Authentication: Bearer token with admin scope.

Success response (200):

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "enum": [
        true
      ]
    },
    "alreadyRevoked": {
      "type": "boolean"
    },
    "apiToken": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "principalId": {
          "type": "string"
        },
        "revokedAt": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "name",
        "principalId",
        "revokedAt"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "ok",
    "alreadyRevoked",
    "apiToken"
  ],
  "additionalProperties": false
}
```

### `GET /api/drafts/:draftId`

Read one draft through the moderation view.

Authentication: Bearer token with admin scope.

Success response (200):

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "enum": [
        true
      ]
    },
    "draft": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "principalId": {
          "type": "string"
        },
        "createdByApiTokenId": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "title": {
          "type": "string"
        },
        "createdAt": {
          "type": "string"
        },
        "updatedAt": {
          "type": "string"
        },
        "expiresAt": {
          "type": "string"
        },
        "pinnedAt": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "deletedAt": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "disabledAt": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "disabledReason": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "id",
        "principalId",
        "createdByApiTokenId",
        "title",
        "createdAt",
        "updatedAt",
        "expiresAt",
        "pinnedAt",
        "deletedAt",
        "disabledAt",
        "disabledReason"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "ok",
    "draft"
  ],
  "additionalProperties": false
}
```

### `GET /api/principals/:principalId/drafts`

List the drafts owned by one principal for moderation.

Authentication: Bearer token with admin scope.

Success response (200):

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "enum": [
        true
      ]
    },
    "principalId": {
      "type": "string"
    },
    "drafts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "principalId": {
            "type": "string"
          },
          "createdByApiTokenId": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "title": {
            "type": "string"
          },
          "createdAt": {
            "type": "string"
          },
          "updatedAt": {
            "type": "string"
          },
          "expiresAt": {
            "type": "string"
          },
          "pinnedAt": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "deletedAt": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "disabledAt": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "disabledReason": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "principalId",
          "createdByApiTokenId",
          "title",
          "createdAt",
          "updatedAt",
          "expiresAt",
          "pinnedAt",
          "deletedAt",
          "disabledAt",
          "disabledReason"
        ],
        "additionalProperties": false
      }
    },
    "truncated": {
      "type": "boolean"
    }
  },
  "required": [
    "ok",
    "principalId",
    "drafts",
    "truncated"
  ],
  "additionalProperties": false
}
```

### `POST /api/uploads`

Create a draft or add a version to an existing draft.

Authentication: Bearer token.

Request body:

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "html": {
      "type": "string"
    },
    "filename": {
      "type": "string"
    },
    "draftId": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "metadata": {
      "type": "object",
      "properties": {
        "repoOrg": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "repoName": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "gitBranch": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "gitCommitSha": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "cliVersion": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "fileSha256": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "additionalProperties": false
    }
  },
  "required": [
    "html"
  ],
  "additionalProperties": false
}
```

Success response (200 for an update; 201 for a create):

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "enum": [
        true
      ]
    },
    "draftId": {
      "type": "string"
    },
    "versionId": {
      "type": "string"
    },
    "versionNumber": {
      "anyOf": [
        {
          "type": "number"
        },
        {
          "type": "string",
          "enum": [
            "Infinity",
            "-Infinity",
            "NaN"
          ]
        }
      ]
    },
    "title": {
      "type": "string"
    },
    "publicUrl": {
      "type": "string"
    },
    "warnings": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "ok",
    "draftId",
    "versionId",
    "versionNumber",
    "title",
    "publicUrl",
    "warnings"
  ],
  "additionalProperties": false
}
```

### `POST /api/drafts/:draftId/disable`

Take a draft out of service while retaining it.

Authentication: Bearer token.

Request body:

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "reason": {
      "type": "string"
    }
  },
  "additionalProperties": false
}
```

Success response (200):

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "enum": [
        true
      ]
    }
  },
  "required": [
    "ok"
  ],
  "additionalProperties": false
}
```

### `POST /api/drafts/:draftId/pin`

Exempt an active draft from expiry.

Authentication: Bearer token with admin scope.

Success response (200):

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "enum": [
        true
      ]
    },
    "pinned": {
      "type": "boolean"
    }
  },
  "required": [
    "ok",
    "pinned"
  ],
  "additionalProperties": false
}
```

### `POST /api/drafts/:draftId/unpin`

Return a draft to ordinary expiry behavior.

Authentication: Bearer token with admin scope.

Success response (200):

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "enum": [
        true
      ]
    },
    "pinned": {
      "type": "boolean"
    }
  },
  "required": [
    "ok",
    "pinned"
  ],
  "additionalProperties": false
}
```

### `DELETE /api/drafts/:draftId`

Permanently delete a draft.

Authentication: Bearer token.

Success response (200):

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "enum": [
        true
      ]
    }
  },
  "required": [
    "ok"
  ],
  "additionalProperties": false
}
```

### API error response

Routes can return the following shared error shape with a non-2xx status. Fields beyond `ok` are present when relevant to the failure.

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "enum": [
        false
      ]
    },
    "error": {
      "type": "string"
    },
    "errors": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "warnings": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "code": {
      "type": "string"
    },
    "quota": {
      "anyOf": [
        {
          "type": "number"
        },
        {
          "type": "string",
          "enum": [
            "Infinity",
            "-Infinity",
            "NaN"
          ]
        }
      ]
    },
    "limit": {
      "anyOf": [
        {
          "type": "number"
        },
        {
          "type": "string",
          "enum": [
            "Infinity",
            "-Infinity",
            "NaN"
          ]
        }
      ]
    },
    "retryAfterSeconds": {
      "anyOf": [
        {
          "type": "number"
        },
        {
          "type": "string",
          "enum": [
            "Infinity",
            "-Infinity",
            "NaN"
          ]
        }
      ]
    }
  },
  "required": [
    "ok"
  ],
  "additionalProperties": false
}
```

## CLI `--json` output

Each command keeps its human-readable default and prints only the documented shape when `--json` is supplied.

### `patchy auth set --json`

Confirm where the credential was stored without exposing it.

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "enum": [
        true
      ]
    },
    "instanceUrl": {
      "type": "string"
    }
  },
  "required": [
    "ok",
    "instanceUrl"
  ],
  "additionalProperties": false
}
```

### `patchy whoami --json`

Print the exact identity response returned by the instance.

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "accountId": {
      "type": "string"
    },
    "accountName": {
      "type": "string"
    },
    "apiTokenId": {
      "type": "string"
    },
    "apiTokenName": {
      "type": "string"
    },
    "scopes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "accountId",
    "accountName",
    "apiTokenId",
    "apiTokenName",
    "scopes"
  ],
  "additionalProperties": false
}
```

### `patchy status --json`

Report local publishing state for the resolved instance.

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "instanceUrl": {
      "type": "string"
    },
    "instanceSource": {
      "type": "string",
      "enum": [
        "flag",
        "env",
        "config",
        "default"
      ]
    },
    "hasToken": {
      "type": "boolean"
    },
    "tokenSource": {
      "anyOf": [
        {
          "type": "string",
          "enum": [
            "mint",
            "auth-set"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "stateDir": {
      "type": "string"
    },
    "hasDefaultStyle": {
      "type": "boolean"
    },
    "cliVersion": {
      "type": "string"
    }
  },
  "required": [
    "instanceUrl",
    "instanceSource",
    "hasToken",
    "tokenSource",
    "stateDir",
    "hasDefaultStyle",
    "cliVersion"
  ],
  "additionalProperties": false
}
```

### `patchy validate --json`

Report the complete local HTML validation result.

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean"
    },
    "errors": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "warnings": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "title": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "ok",
    "errors",
    "warnings",
    "title"
  ],
  "additionalProperties": false
}
```

### `patchy upload --json`

Print the exact successful upload response returned by the instance.

<!-- prettier-ignore -->
```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "enum": [
        true
      ]
    },
    "draftId": {
      "type": "string"
    },
    "versionId": {
      "type": "string"
    },
    "versionNumber": {
      "anyOf": [
        {
          "type": "number"
        },
        {
          "type": "string",
          "enum": [
            "Infinity",
            "-Infinity",
            "NaN"
          ]
        }
      ]
    },
    "title": {
      "type": "string"
    },
    "publicUrl": {
      "type": "string"
    },
    "warnings": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "ok",
    "draftId",
    "versionId",
    "versionNumber",
    "title",
    "publicUrl",
    "warnings"
  ],
  "additionalProperties": false
}
```
