(() => {
  if (window.__slaprfApiSpecViewerInit) return;
  window.__slaprfApiSpecViewerInit = true;

  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const highlightJSON = (value) => {
    const jsonStr =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        return esc(jsonStr);
      }
    }
    const tokenRegex =
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?|[{}[\],:])/g;
    let lastIdx = 0;
    let out = "";
    let match;
    while ((match = tokenRegex.exec(jsonStr)) !== null) {
      if (match.index > lastIdx) {
        out += esc(jsonStr.slice(lastIdx, match.index));
      }
      const tok = match[0];
      if (tok.startsWith('"')) {
        if (tok.endsWith(":")) {
          const colonIdx = tok.lastIndexOf(":");
          const keyPart = tok.slice(0, colonIdx);
          const restPart = tok.slice(colonIdx);
          out += `<span class="sw-json-key">${esc(keyPart)}</span><span class="sw-json-punc">${esc(restPart)}</span>`;
        } else {
          out += `<span class="sw-json-str">${esc(tok)}</span>`;
        }
      } else if (tok === "true" || tok === "false") {
        out += `<span class="sw-json-bool">${esc(tok)}</span>`;
      } else if (tok === "null") {
        out += `<span class="sw-json-null">${esc(tok)}</span>`;
      } else if (/^[{}[\],:]$/.test(tok)) {
        out += `<span class="sw-json-punc">${esc(tok)}</span>`;
      } else {
        out += `<span class="sw-json-num">${esc(tok)}</span>`;
      }
      lastIdx = tokenRegex.lastIndex;
    }
    if (lastIdx < jsonStr.length) {
      out += esc(jsonStr.slice(lastIdx));
    }
    return out;
  };

  const mdInline = (s) => {
    if (!s) return "";
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  };

  const mdBlock = (s) => {
    if (!s) return "";
    const lines = String(s).replace(/\r\n/g, "\n").split("\n");
    let html = "";
    let paraLines = [];
    let listOpen = false;
    let subListOpen = false;
    let liOpen = false;

    const flushPara = () => {
      if (paraLines.length > 0) {
        html += `<p class="sw-md-p">${paraLines
          .map((l) => mdInline(l))
          .join("<br/>")}</p>`;
        paraLines = [];
      }
    };

    const closeLists = () => {
      if (subListOpen) {
        html += "</ul>";
        subListOpen = false;
      }
      if (liOpen) {
        html += "</li>";
        liOpen = false;
      }
      if (listOpen) {
        html += "</ul>";
        listOpen = false;
      }
    };

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        flushPara();
        closeLists();
        continue;
      }
      const subMatch = rawLine.match(/^\s{2,}[-*]\s+(.+)$/);
      const topMatch = !subMatch && rawLine.match(/^\s*[-*]\s+(.+)$/);
      if (topMatch) {
        flushPara();
        if (subListOpen) {
          html += "</ul>";
          subListOpen = false;
        }
        if (liOpen) {
          html += "</li>";
          liOpen = false;
        }
        if (!listOpen) {
          html += '<ul class="sw-md-list">';
          listOpen = true;
        }
        html += `<li>${mdInline(topMatch[1])}`;
        liOpen = true;
      } else if (subMatch) {
        flushPara();
        if (!listOpen) {
          html += '<ul class="sw-md-list"><li>';
          listOpen = true;
          liOpen = true;
        }
        if (!subListOpen) {
          html += '<ul class="sw-md-sublist">';
          subListOpen = true;
        }
        html += `<li>${mdInline(subMatch[1])}</li>`;
      } else {
        closeLists();
        paraLines.push(trimmed);
      }
    }
    flushPara();
    closeLists();
    return html;
  };

  // Minimal indented YAML parser sufficient for OpenAPI 3.1.0 & AsyncAPI 3.0.0 specs
  const parseYAML = (text) => {
    const rawLines = text.replace(/\r\n/g, "\n").split("\n");
    const lines = [];
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        lines.push({ indent: -1, raw: line, trimmed: "" });
        continue;
      }
      const indent = line.match(/^ */)[0].length;
      lines.push({ indent, raw: line, trimmed });
    }

    const parseScalar = (val) => {
      const t = val.trim();
      if (!t) return "";
      if (
        (t.startsWith('"') && t.endsWith('"')) ||
        (t.startsWith("'") && t.endsWith("'"))
      ) {
        return t.slice(1, -1);
      }
      if (t === "true") return true;
      if (t === "false") return false;
      if (t === "null" || t === "~") return null;
      if (t === "[]") return [];
      if (t === "{}") return {};
      if (t.startsWith("[") && t.endsWith("]")) {
        const inner = t.slice(1, -1).trim();
        if (!inner) return [];
        const items = [];
        let cur = "";
        let inSingle = false;
        let inDouble = false;
        for (let i = 0; i < inner.length; i++) {
          const ch = inner[i];
          if (ch === "'" && !inDouble) inSingle = !inSingle;
          else if (ch === '"' && !inSingle) inDouble = !inDouble;
          if (ch === "," && !inSingle && !inDouble) {
            items.push(parseScalar(cur));
            cur = "";
          } else {
            cur += ch;
          }
        }
        items.push(parseScalar(cur));
        return items;
      }
      if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
      return t;
    };

    const splitKeyVal = (str) => {
      let inSingle = false;
      let inDouble = false;
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (
          ch === ":" &&
          !inSingle &&
          !inDouble &&
          (i === str.length - 1 || str[i + 1] === " ")
        ) {
          let k = str.slice(0, i).trim();
          if (
            (k.startsWith('"') && k.endsWith('"')) ||
            (k.startsWith("'") && k.endsWith("'"))
          ) {
            k = k.slice(1, -1);
          }
          return [k, str.slice(i + 1).trim()];
        }
      }
      return null;
    };

    const nextNonEmpty = (startIdx) => {
      for (let i = startIdx; i < lines.length; i++) {
        if (lines[i].indent >= 0) return i;
      }
      return -1;
    };

    const parseBlock = (startIdx, minIndent) => {
      const firstIdx = nextNonEmpty(startIdx);
      if (firstIdx < 0 || lines[firstIdx].indent < minIndent) {
        return [null, startIdx];
      }
      if (lines[firstIdx].trimmed.startsWith("- ")) {
        return parseSeq(firstIdx, lines[firstIdx].indent);
      }
      return parseMap(firstIdx, lines[firstIdx].indent);
    };

    const parseMultiline = (startIdx, parentIndent) => {
      const chunks = [];
      let blockIndent = -1;
      let i = startIdx;
      for (; i < lines.length; i++) {
        const ln = lines[i];
        if (ln.indent < 0) {
          if (blockIndent >= 0) chunks.push("");
          continue;
        }
        if (ln.indent <= parentIndent) break;
        if (blockIndent < 0) blockIndent = ln.indent;
        chunks.push(ln.raw.slice(blockIndent));
      }
      return [chunks.join("\n").trim(), i];
    };

    const parseSeq = (startIdx, seqIndent) => {
      const arr = [];
      let i = startIdx;
      while (i < lines.length) {
        const idx = nextNonEmpty(i);
        if (idx < 0 || lines[idx].indent < seqIndent) {
          i = idx < 0 ? lines.length : idx;
          break;
        }
        if (
          lines[idx].indent !== seqIndent ||
          !lines[idx].trimmed.startsWith("- ")
        ) {
          i = idx;
          break;
        }
        const rest = lines[idx].trimmed.slice(2).trim();
        const kv = splitKeyVal(rest);
        if (!rest) {
          const [child, nextIdx] = parseBlock(idx + 1, seqIndent + 1);
          arr.push(child);
          i = nextIdx;
        } else if (kv) {
          const obj = {};
          const [k, v] = kv;
          if (v === "|" || v === ">") {
            const [ml, nextIdx] = parseMultiline(idx + 1, seqIndent);
            obj[k] = ml;
            i = nextIdx;
          } else if (v !== "") {
            obj[k] = parseScalar(v);
            i = idx + 1;
          } else {
            const [child, nextIdx] = parseBlock(idx + 1, seqIndent + 2);
            obj[k] = child;
            i = nextIdx;
          }
          const subIdx = nextNonEmpty(i);
          if (subIdx >= 0 && lines[subIdx].indent > seqIndent) {
            const [moreMap, nextIdx2] = parseMap(
              subIdx,
              lines[subIdx].indent,
              obj
            );
            i = nextIdx2;
            arr.push(moreMap);
          } else {
            arr.push(obj);
          }
        } else {
          arr.push(parseScalar(rest));
          i = idx + 1;
        }
      }
      return [arr, i];
    };

    const parseMap = (startIdx, mapIndent, targetObj) => {
      const obj = targetObj || {};
      let i = startIdx;
      while (i < lines.length) {
        const idx = nextNonEmpty(i);
        if (idx < 0 || lines[idx].indent < mapIndent) {
          i = idx < 0 ? lines.length : idx;
          break;
        }
        if (
          lines[idx].indent !== mapIndent ||
          lines[idx].trimmed.startsWith("- ")
        ) {
          i = idx;
          break;
        }
        const kv = splitKeyVal(lines[idx].trimmed);
        if (!kv) {
          i = idx + 1;
          continue;
        }
        const [k, v] = kv;
        if (v === "|" || v === ">") {
          const [ml, nextIdx] = parseMultiline(idx + 1, mapIndent);
          obj[k] = ml;
          i = nextIdx;
        } else if (v !== "") {
          obj[k] = parseScalar(v);
          i = idx + 1;
        } else {
          const [child, nextIdx] = parseBlock(idx + 1, mapIndent + 1);
          obj[k] = child;
          i = nextIdx;
        }
      }
      return [obj, i];
    };

    const [root] = parseBlock(0, 0);
    return root || {};
  };

  const resolveRef = (root, ref) => {
    if (!ref || typeof ref !== "string" || !ref.startsWith("#/")) return null;
    const parts = ref.slice(2).split("/");
    let cur = root;
    for (const p of parts) {
      if (!cur || typeof cur !== "object") return null;
      cur = cur[p];
    }
    return cur || null;
  };

  const formatSchemaTitle = (root, schema) => {
    if (!schema) return "any";
    if (schema.$ref) {
      const name = schema.$ref.split("/").pop();
      return name;
    }
    if (schema.type === "array") {
      return `${formatSchemaTitle(root, schema.items)}[]`;
    }
    if (schema.enum) {
      return `${schema.type || "string"} (${schema.enum.join(" | ")})`;
    }
    if (schema.const) {
      return `"${schema.const}"`;
    }
    if (schema.format) {
      return `${schema.type || "string"} (${schema.format})`;
    }
    return schema.type || "object";
  };

  const buildExampleFromSchema = (root, schema, depth = 0) => {
    if (!schema || depth > 12) return {};
    if (schema.$ref) {
      const resolved = resolveRef(root, schema.$ref);
      return buildExampleFromSchema(root, resolved, depth + 1);
    }
    if (schema.example !== undefined) return schema.example;
    if (schema.const !== undefined) return schema.const;
    if (schema.enum && schema.enum.length > 0) return schema.enum[0];
    if (schema.type === "array") {
      return [buildExampleFromSchema(root, schema.items, depth + 1)];
    }
    if (schema.type === "object" || schema.properties) {
      const out = {};
      const props = schema.properties || {};
      for (const [k, v] of Object.entries(props)) {
        out[k] = buildExampleFromSchema(root, v, depth + 1);
      }
      return out;
    }
    if (schema.type === "integer" || schema.type === "number") return 0;
    if (schema.type === "boolean") return true;
    return "string";
  };

  const renderSchemaPropertiesTable = (root, schema) => {
    if (!schema) return "";
    const resolved = schema.$ref ? resolveRef(root, schema.$ref) : schema;
    if (!resolved) return "";
    const target =
      resolved.type === "array" && resolved.items
        ? resolved.items.$ref
          ? resolveRef(root, resolved.items.$ref)
          : resolved.items
        : resolved;
    if (!target || !target.properties) {
      return `<div class="sw-schema-inline-type">Schema: <code>${esc(
        formatSchemaTitle(root, schema)
      )}</code></div>`;
    }
    const reqSet = new Set(Array.isArray(target.required) ? target.required : []);
    const rows = Object.entries(target.properties)
      .map(([propName, propSchema]) => {
        const pResolved =
          propSchema && propSchema.$ref
            ? resolveRef(root, propSchema.$ref) || propSchema
            : propSchema || {};
        const typeStr = formatSchemaTitle(root, propSchema);
        const isReq = reqSet.has(propName);
        const desc = pResolved.description || "";
        const ex =
          pResolved.example !== undefined
            ? `Example: <code>${esc(JSON.stringify(pResolved.example))}</code>`
            : "";
        return `
          <tr>
            <td class="sw-prop-name">
              <code>${esc(propName)}</code>
              ${isReq ? '<span class="sw-req-badge">required</span>' : ""}
            </td>
            <td class="sw-prop-type"><code>${esc(typeStr)}</code></td>
            <td class="sw-prop-desc">${mdInline(desc)} ${ex}</td>
          </tr>
        `;
      })
      .join("");

    return `
      <table class="sw-prop-table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Type</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  };

  // =========================================================================
  // 1. SlapRF-Styled OpenAPI 3.1.0 Renderer (Swagger UI Layout)
  // =========================================================================
  const renderOpenAPI = (container, spec, specUrl) => {
    const info = spec.info || {};
    const tags = Array.isArray(spec.tags) ? spec.tags : [];
    const paths = spec.paths || {};
    const schemas = (spec.components && spec.components.schemas) || {};

    const methodsOrder = ["get", "post", "put", "patch", "delete"];
    const tagGroups = new Map();
    tags.forEach((t) =>
      tagGroups.set(t.name, {
        summary: t["x-summary"] || "",
        description: t.description || "",
        ops: [],
      })
    );

    Object.entries(paths).forEach(([pathKey, pathObj]) => {
      if (!pathObj || typeof pathObj !== "object") return;
      const pathParams = Array.isArray(pathObj.parameters)
        ? pathObj.parameters
        : [];
      methodsOrder.forEach((m) => {
        const op = pathObj[m];
        if (!op) return;
        const opTags =
          Array.isArray(op.tags) && op.tags.length > 0 ? op.tags : ["Default"];
        const mergedParams = [
          ...pathParams,
          ...(Array.isArray(op.parameters) ? op.parameters : []),
        ];
        opTags.forEach((tName) => {
          if (!tagGroups.has(tName)) {
            tagGroups.set(tName, { summary: "", description: "", ops: [] });
          }
          tagGroups.get(tName).ops.push({
            method: m.toUpperCase(),
            path: pathKey,
            op,
            params: mergedParams,
          });
        });
      });
    });

    let totalOps = 0;
    tagGroups.forEach((g) => {
      totalOps += g.ops.length;
    });

    const tagSectionsHtml = Array.from(tagGroups.entries())
      .filter(([, group]) => group.ops.length > 0)
      .map(([tagName, group], tagIdx) => {
        const opsHtml = group.ops
          .map((item, opIdx) => {
            const { method, path, op, params } = item;
            const opId = `sw-op-${tagIdx}-${opIdx}`;
            const methodLower = method.toLowerCase();
            const isAction = path.includes(":");

            const paramsRows = params
              .map((p) => {
                const pSchema = p.schema || {};
                return `
                  <tr>
                    <td>
                      <code>${esc(p.name)}</code>
                      ${
                        p.required
                          ? '<span class="sw-req-badge">required</span>'
                          : ""
                      }
                    </td>
                    <td><span class="sw-in-pill">${esc(p.in || "query")}</span></td>
                    <td><code>${esc(formatSchemaTitle(spec, pSchema))}</code></td>
                    <td>${mdInline(p.description || "")}</td>
                  </tr>
                `;
              })
              .join("");

            let reqBodyHtml = "";
            if (op.requestBody && op.requestBody.content) {
              const contentEntries = Object.entries(op.requestBody.content);
              if (contentEntries.length > 0) {
                const [ctype, mediaObj] = contentEntries[0];
                const bodySchema = mediaObj && mediaObj.schema;
                const sample = buildExampleFromSchema(spec, bodySchema);
                reqBodyHtml = `
                  <div class="sw-op-section">
                    <div class="sw-op-section-head">
                      <span>Request Body ${
                        op.requestBody.required
                          ? '<span class="sw-req-badge">required</span>'
                          : ""
                      }</span>
                      <code class="sw-media-pill">${esc(ctype)}</code>
                    </div>
                    ${renderSchemaPropertiesTable(spec, bodySchema)}
                    <pre class="sw-json-preview"><code>${highlightJSON(
                      sample
                    )}</code></pre>
                  </div>
                `;
              }
            }

            const responsesObj = op.responses || {};
            const respCards = Object.entries(responsesObj)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([code, rawRObj], rIdx) => {
                const rObj =
                  rawRObj && rawRObj.$ref
                    ? resolveRef(spec, rawRObj.$ref) || rawRObj
                    : rawRObj || {};
                const respId = `${opId}-resp-${rIdx}`;
                const codeClass = code.startsWith("2")
                  ? "is-2xx"
                  : code.startsWith("4")
                  ? "is-4xx"
                  : "is-default";
                let schemaBadge = "";
                let headersBadge = "";
                let exampleBlock = "";
                if (rObj && rObj.headers) {
                  headersBadge = Object.keys(rObj.headers)
                    .map((h) => {
                      const hObj = rObj.headers[h] || {};
                      const hEx =
                        hObj.schema && hObj.schema.example
                          ? ` = <code>${esc(hObj.schema.example)}</code>`
                          : "";
                      return `<span class="sw-header-pill">Header: <code>${esc(
                        h
                      )}</code>${hEx}</span>`;
                    })
                    .join(" ");
                }
                if (rObj && rObj.content) {
                  const [cType, mObj] = Object.entries(rObj.content)[0] || [];
                  if (cType) {
                    const sTitle =
                      mObj && mObj.schema
                        ? formatSchemaTitle(spec, mObj.schema)
                        : cType;
                    schemaBadge = `<code class="sw-schema-chip">${esc(
                      sTitle
                    )}</code> <span class="sw-ctype-muted">(${esc(
                      cType
                    )})</span>`;
                    let sampleVal = null;
                    if (mObj && mObj.example !== undefined) {
                      sampleVal = mObj.example;
                    } else if (
                      mObj &&
                      mObj.examples &&
                      Object.values(mObj.examples)[0] &&
                      Object.values(mObj.examples)[0].value !== undefined
                    ) {
                      sampleVal = Object.values(mObj.examples)[0].value;
                    } else if (cType.includes("csv")) {
                      sampleVal =
                        "slotIndex,callsign,phoneticName,band,channel,frequencyMhz\n1,VORTEX,vor-teks,1,1,5658";
                    } else if (mObj && mObj.schema) {
                      sampleVal = buildExampleFromSchema(spec, mObj.schema);
                    }
                    if (sampleVal !== null && sampleVal !== undefined) {
                      exampleBlock = `<pre class="sw-json-preview is-resp-preview"><code>${highlightJSON(
                        sampleVal
                      )}</code></pre>`;
                    }
                  }
                }
                if (exampleBlock) {
                  return `
                    <div class="sw-resp-card ${codeClass}">
                      <button type="button" class="sw-resp-head is-collapsible" data-sw-toggle="${respId}" aria-expanded="false">
                        <span class="sw-status-pill ${codeClass}">${esc(
                    code
                  )}</span>
                        <span class="sw-resp-desc">${mdInline(
                          (rObj && rObj.description) || ""
                        )}</span>
                        <span class="sw-resp-meta">
                          ${headersBadge}
                          ${schemaBadge}
                          <span class="sw-resp-example-hint">Example</span>
                          <svg class="sw-chevron" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M6 8l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/>
                          </svg>
                        </span>
                      </button>
                      <div class="sw-resp-body" id="${respId}" hidden>
                        ${exampleBlock}
                      </div>
                    </div>
                  `;
                }
                return `
                  <div class="sw-resp-card ${codeClass}">
                    <div class="sw-resp-head">
                      <span class="sw-status-pill ${codeClass}">${esc(
                  code
                )}</span>
                      <span class="sw-resp-desc">${mdInline(
                        (rObj && rObj.description) || ""
                      )}</span>
                      <span class="sw-resp-meta">${headersBadge} ${schemaBadge}</span>
                    </div>
                  </div>
                `;
              })
              .join("");

            return `
              <div class="sw-opblock is-${methodLower}" data-sw-opblock data-method="${esc(
              method
            )}" data-path="${esc(path.toLowerCase())}" data-summary="${esc(
              (op.summary || "").toLowerCase()
            )}">
                <button type="button" class="sw-opblock-summary" data-sw-toggle="${opId}" aria-expanded="false">
                  <span class="sw-opblock-method is-${methodLower}">${esc(
              method
            )}</span>
                  <span class="sw-opblock-path">
                    <code>${esc(path)}</code>
                    ${
                      isAction
                        ? '<span class="sw-action-chip">:action</span>'
                        : ""
                    }
                  </span>
                  <span class="sw-opblock-desc">${esc(op.summary || "")}</span>
                  <svg class="sw-chevron" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M6 8l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
                <div class="sw-opblock-body" id="${opId}" hidden>
                  ${
                    op.operationId
                      ? `<div class="sw-op-meta">Operation ID: <code>${esc(
                          op.operationId
                        )}</code></div>`
                      : ""
                  }
                  ${
                    params.length > 0
                      ? `
                    <div class="sw-op-section">
                      <div class="sw-op-section-head"><span>Parameters</span></div>
                      <table class="sw-prop-table">
                        <thead><tr><th>Name</th><th>In</th><th>Type</th><th>Description</th></tr></thead>
                        <tbody>${paramsRows}</tbody>
                      </table>
                    </div>`
                      : ""
                  }
                  ${reqBodyHtml}
                  <div class="sw-op-section">
                    <div class="sw-op-section-head"><span>Responses</span></div>
                    <div class="sw-resp-list">${respCards}</div>
                  </div>
                </div>
              </div>
            `;
          })
          .join("");

        return `
          <section class="sw-tag-section" data-sw-tag-section data-expanded="true">
            <div class="sw-tag-header-bar">
              <button type="button" class="sw-tag-header" data-sw-tag-toggle aria-expanded="true">
                <div class="sw-tag-title-wrap">
                  <span class="sw-tag-name">${esc(tagName)}</span>
                  <span class="sw-tag-count">${group.ops.length}</span>
                </div>
              </button>
              <div class="sw-tag-header-actions">
                <button type="button" class="sw-tag-ops-btn" data-sw-section-expand-ops data-expanded="false">Expand</button>
                <button type="button" class="sw-tag-chevron-btn" data-sw-tag-toggle aria-expanded="true" aria-label="Toggle category">
                  <svg class="sw-chevron" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M6 8l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
              </div>
            </div>
            <div class="sw-tag-ops">
              ${
                group.description
                  ? `<div class="aa-channel-desc">${mdBlock(
                      group.description
                    )}</div>`
                  : ""
              }
              ${opsHtml}
            </div>
          </section>
        `;
      })
      .join("");

    const schemasHtml = Object.entries(schemas)
      .map(([schemaName, schemaObj], sIdx) => {
        const sId = `sw-schema-${sIdx}`;
        return `
          <div class="sw-schema-card">
            <button type="button" class="sw-schema-header" data-sw-toggle="${sId}" aria-expanded="false">
              <span class="sw-schema-title"><code>${esc(schemaName)}</code></span>
              <span class="sw-schema-kind">${esc(
                formatSchemaTitle(spec, schemaObj)
              )}</span>
              <svg class="sw-chevron" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M6 8l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <div class="sw-schema-body" id="${sId}" hidden>
              ${renderSchemaPropertiesTable(spec, schemaObj)}
            </div>
          </div>
        `;
      })
      .join("");

    container.innerHTML = `
      <div class="sw-ui-shell">
        <div class="sw-topbar">
          <div class="sw-title-row">
            <div class="sw-title-group">
              <h3 class="sw-api-title">${esc(info.title || "OpenAPI Specification")}</h3>
              <span class="sw-version-pill">v${esc(info.version || "1.0.0")}</span>
              <span class="sw-standard-pill is-oas">OAS ${esc(
                spec.openapi || "3.1.0"
              )}</span>
              <span class="sw-count-pill">${totalOps} operations</span>
            </div>
            <div class="sw-actions-group">
              <button type="button" class="sw-action-btn" data-sw-toggle-categories data-expanded="true">Collapse</button>
              <a class="sw-download-btn" href="${esc(specUrl)}" download="openapi.yaml">
                <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M10 3v10m0 0l-3.5-3.5M10 13l3.5-3.5M4 16h12" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <span>openapi.yaml</span>
              </a>
            </div>
          </div>
          <div class="sw-controls-bar">
            <label class="sw-filter-label">
              <input type="search" class="sw-filter-input" data-sw-filter placeholder="Filter by path, method, or summary (e.g. /v1/race or POST)..." />
            </label>
          </div>
        </div>
        <div class="sw-tags-container">${tagSectionsHtml}</div>
        <div class="sw-schemas-section">
          <div class="sw-schemas-heading">
            <span>Schemas (${Object.keys(schemas).length})</span>
          </div>
          <div class="sw-schemas-list">${schemasHtml}</div>
        </div>
      </div>
    `;

    bindSwaggerInteractions(container);
  };

  // =========================================================================
  // 2. SlapRF-Styled AsyncAPI 3.0.0 Renderer (AsyncAPI Studio Layout)
  // =========================================================================
  const renderAsyncAPI = (container, spec, specUrl) => {
    const info = spec.info || {};
    const channels = spec.channels || {};
    const operations = spec.operations || {};
    const messages = (spec.components && spec.components.messages) || {};
    const schemas = (spec.components && spec.components.schemas) || {};

    const channelsHtml = Object.entries(channels)
      .map(([chanKey, chan], cIdx) => {
        const chanOps = Object.entries(operations).filter(([, op]) => {
          return (
            op.channel &&
            typeof op.channel.$ref === "string" &&
            op.channel.$ref.endsWith(`/${chanKey}`)
          );
        });

        const chanMsgs = chan.messages || {};
        const msgCards = Object.entries(chanMsgs)
          .map(([msgAlias, msgRefObj], mIdx) => {
            const msg =
              msgRefObj && msgRefObj.$ref
                ? resolveRef(spec, msgRefObj.$ref) || msgRefObj
                : msgRefObj || {};
            const mId = `aa-msg-${cIdx}-${mIdx}`;
            const isBinary =
              (msg.contentType || "").includes("octet-stream") ||
              msgAlias.toLowerCase().includes("binary");
            const payloadSchema = msg.payload;
            const exampleObj =
              Array.isArray(msg.examples) &&
              msg.examples.length > 0 &&
              msg.examples[0].payload
                ? msg.examples[0].payload
                : !isBinary
                ? buildExampleFromSchema(spec, payloadSchema)
                : null;

            return `
              <div class="sw-opblock is-async-${
                isBinary ? "binary" : "json"
              }" data-sw-opblock data-method="${
              isBinary ? "BINARY" : "MSG"
            }" data-path="${esc(
              `${chan.address || chanKey} ${msg.name || msgAlias}`.toLowerCase()
            )}" data-summary="${esc(
              (msg.title || msg.summary || "").toLowerCase()
            )}">
                <button type="button" class="sw-opblock-summary" data-sw-toggle="${mId}" aria-expanded="false">
                  <span class="sw-opblock-method is-async-${
                    isBinary ? "binary" : "json"
                  }">${isBinary ? "BINARY" : "MSG"}</span>
                  <span class="sw-opblock-path">
                    <code>${esc(msg.name || msgAlias)}</code>
                    <span class="sw-media-pill">${esc(
                      msg.contentType || "application/json"
                    )}</span>
                  </span>
                  <span class="sw-opblock-desc">${esc(
                    msg.title || msg.summary || ""
                  )}</span>
                  <svg class="sw-chevron" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M6 8l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
                <div class="sw-opblock-body" id="${mId}" hidden>
                  ${
                    msg.summary
                      ? `<div class="aa-msg-summary">${mdBlock(
                          msg.summary
                        )}</div>`
                      : ""
                  }
                  <div class="sw-op-section">
                    <div class="sw-op-section-head"><span>Payload Schema</span></div>
                    ${renderSchemaPropertiesTable(spec, payloadSchema)}
                    ${
                      exampleObj
                        ? `<pre class="sw-json-preview"><code>${highlightJSON(
                            exampleObj
                          )}</code></pre>`
                        : ""
                    }
                  </div>
                </div>
              </div>
            `;
          })
          .join("");

        const opBadges = chanOps
          .map(
            ([opKey, op]) =>
              `<span class="aa-op-pill is-${esc(op.action || "receive")}">${esc(
                (op.action || "receive").toUpperCase()
              )} <code>${esc(opKey)}</code></span>`
          )
          .join(" ");

        return `
          <section class="sw-tag-section" data-sw-tag-section data-expanded="true">
            <div class="sw-tag-header-bar">
              <button type="button" class="sw-tag-header" data-sw-tag-toggle aria-expanded="true">
                <div class="sw-tag-title-wrap">
                  <span class="aa-channel-pill">CHANNEL</span>
                  <code class="aa-channel-addr">${esc(
                    chan.address || chanKey
                  )}</code>
                  <span class="sw-tag-desc">${esc(chan.title || "")}</span>
                  ${opBadges}
                </div>
              </button>
              <div class="sw-tag-header-actions">
                <button type="button" class="sw-tag-ops-btn" data-sw-section-expand-ops data-expanded="false">Expand</button>
                <button type="button" class="sw-tag-chevron-btn" data-sw-tag-toggle aria-expanded="true" aria-label="Toggle channel">
                  <svg class="sw-chevron" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M6 8l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
              </div>
            </div>
            <div class="sw-tag-ops">
              ${
                chan.description
                  ? `<div class="aa-channel-desc">${mdBlock(
                      chan.description
                    )}</div>`
                  : ""
              }
              ${msgCards}
            </div>
          </section>
        `;
      })
      .join("");

    const schemasHtml = Object.entries(schemas)
      .map(([schemaName, schemaObj], sIdx) => {
        const sId = `aa-schema-${sIdx}`;
        return `
          <div class="sw-schema-card">
            <button type="button" class="sw-schema-header" data-sw-toggle="${sId}" aria-expanded="false">
              <span class="sw-schema-title"><code>${esc(schemaName)}</code></span>
              <span class="sw-schema-kind">${esc(
                formatSchemaTitle(spec, schemaObj)
              )}</span>
              <svg class="sw-chevron" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M6 8l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <div class="sw-schema-body" id="${sId}" hidden>
              ${renderSchemaPropertiesTable(spec, schemaObj)}
            </div>
          </div>
        `;
      })
      .join("");

    container.innerHTML = `
      <div class="sw-ui-shell is-asyncapi">
        <div class="sw-topbar">
          <div class="sw-title-row">
            <div class="sw-title-group">
              <h3 class="sw-api-title">${esc(
                info.title || "AsyncAPI Specification"
              )}</h3>
              <span class="sw-version-pill">v${esc(
                info.version || "1.0.0"
              )}</span>
              <span class="sw-standard-pill is-async">AsyncAPI ${esc(
                spec.asyncapi || "3.0.0"
              )}</span>
              <span class="sw-count-pill">${
                Object.keys(channels).length
              } channels · ${Object.keys(messages).length} messages</span>
            </div>
            <div class="sw-actions-group">
              <button type="button" class="sw-action-btn" data-sw-toggle-categories data-expanded="true">Collapse</button>
              <a class="sw-download-btn" href="${esc(
                specUrl
              )}" download="asyncapi.yaml">
                <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M10 3v10m0 0l-3.5-3.5M10 13l3.5-3.5M4 16h12" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <span>asyncapi.yaml</span>
              </a>
            </div>
          </div>
          <div class="sw-controls-bar">
            <label class="sw-filter-label">
              <input type="search" class="sw-filter-input" data-sw-filter placeholder="Filter by channel, message name, or summary (e.g. /v1/ws/usb or crossing)..." />
            </label>
          </div>
        </div>
        <div class="sw-tags-container">${channelsHtml}</div>
        <div class="sw-schemas-section">
          <div class="sw-schemas-heading">
            <span>Message Envelopes & Schemas (${Object.keys(schemas).length})</span>
          </div>
          <div class="sw-schemas-list">${schemasHtml}</div>
        </div>
      </div>
    `;

    bindSwaggerInteractions(container);
  };

  const bindSwaggerInteractions = (container) => {
    const setSectionExpanded = (sec, expand) => {
      const ops = sec && sec.querySelector(".sw-tag-ops");
      if (!ops) return;
      sec.setAttribute("data-expanded", expand ? "true" : "false");
      sec.querySelectorAll("[data-sw-tag-toggle]").forEach((btn) => {
        btn.setAttribute("aria-expanded", expand ? "true" : "false");
      });
      ops.hidden = !expand;
    };

    const syncCategoriesBtn = () => {
      const catBtn = container.querySelector("[data-sw-toggle-categories]");
      if (!catBtn) return;
      const sections = Array.from(
        container.querySelectorAll("[data-sw-tag-section]")
      ).filter((s) => !s.hidden);
      const anyExpanded = sections.some(
        (s) => s.getAttribute("data-expanded") !== "false"
      );
      catBtn.setAttribute("data-expanded", anyExpanded ? "true" : "false");
      catBtn.textContent = anyExpanded ? "Collapse" : "Expand";
    };

    const syncSectionOpsBtn = (sec) => {
      if (!sec) return;
      const secBtn = sec.querySelector("[data-sw-section-expand-ops]");
      if (!secBtn) return;
      const opBtns = Array.from(
        sec.querySelectorAll(".sw-opblock > .sw-opblock-summary[data-sw-toggle]")
      ).filter((btn) => !btn.closest(".sw-opblock").hidden);
      const allExpanded =
        opBtns.length > 0 &&
        opBtns.every((btn) => btn.getAttribute("aria-expanded") === "true");
      secBtn.setAttribute("data-expanded", allExpanded ? "true" : "false");
      secBtn.textContent = allExpanded ? "Collapse" : "Expand";
    };

    container.addEventListener("click", (e) => {
      const toggleBtn = e.target.closest("[data-sw-toggle]");
      if (toggleBtn) {
        const targetId = toggleBtn.getAttribute("data-sw-toggle");
        const body = container.querySelector(`#${targetId}`);
        if (!body) return;
        const expanded = toggleBtn.getAttribute("aria-expanded") === "true";
        toggleBtn.setAttribute("aria-expanded", expanded ? "false" : "true");
        body.hidden = expanded;
        if (toggleBtn.classList.contains("sw-opblock-summary")) {
          syncSectionOpsBtn(toggleBtn.closest("[data-sw-tag-section]"));
        }
        return;
      }

      const secOpsBtn = e.target.closest("[data-sw-section-expand-ops]");
      if (secOpsBtn) {
        const sec = secOpsBtn.closest("[data-sw-tag-section]");
        if (!sec) return;
        const next = secOpsBtn.getAttribute("data-expanded") !== "true";
        if (next && sec.getAttribute("data-expanded") === "false") {
          setSectionExpanded(sec, true);
          syncCategoriesBtn();
        }
        sec
          .querySelectorAll(".sw-opblock > .sw-opblock-summary[data-sw-toggle]")
          .forEach((btn) => {
            if (btn.closest(".sw-opblock").hidden) return;
            const id = btn.getAttribute("data-sw-toggle");
            const panel = container.querySelector(`#${id}`);
            btn.setAttribute("aria-expanded", next ? "true" : "false");
            if (panel) panel.hidden = !next;
          });
        syncSectionOpsBtn(sec);
        return;
      }

      const tagBtn = e.target.closest("[data-sw-tag-toggle]");
      if (tagBtn) {
        const sec = tagBtn.closest("[data-sw-tag-section]");
        if (!sec) return;
        const currentlyExpanded = sec.getAttribute("data-expanded") !== "false";
        setSectionExpanded(sec, !currentlyExpanded);
        syncCategoriesBtn();
        return;
      }

      const catToggleBtn = e.target.closest("[data-sw-toggle-categories]");
      if (catToggleBtn) {
        const next = catToggleBtn.getAttribute("data-expanded") !== "true";
        container
          .querySelectorAll("[data-sw-tag-section]")
          .forEach((sec) => setSectionExpanded(sec, next));
        syncCategoriesBtn();
      }
    });

    const filterInput = container.querySelector("[data-sw-filter]");
    if (filterInput) {
      let wasFiltering = false;
      filterInput.addEventListener("input", () => {
        const q = filterInput.value.trim().toLowerCase();
        const sections = container.querySelectorAll("[data-sw-tag-section]");

        if (q && !wasFiltering) {
          sections.forEach((sec) => {
            sec.setAttribute(
              "data-pre-filter-expanded",
              sec.getAttribute("data-expanded") !== "false" ? "true" : "false"
            );
          });
          wasFiltering = true;
        }

        sections.forEach((sec) => {
          let visibleCount = 0;
          sec.querySelectorAll("[data-sw-opblock]").forEach((opEl) => {
            const m = (opEl.getAttribute("data-method") || "").toLowerCase();
            const p = opEl.getAttribute("data-path") || "";
            const s = opEl.getAttribute("data-summary") || "";
            const match = !q || m.includes(q) || p.includes(q) || s.includes(q);
            opEl.hidden = !match;
            if (match) visibleCount++;
          });
          const descEl = sec.querySelector(".aa-channel-desc");
          if (descEl) descEl.hidden = Boolean(q);
          sec.hidden = visibleCount === 0;
          if (q && visibleCount > 0) {
            setSectionExpanded(sec, true);
          }
          syncSectionOpsBtn(sec);
        });

        if (!q && wasFiltering) {
          sections.forEach((sec) => {
            const prev = sec.getAttribute("data-pre-filter-expanded");
            setSectionExpanded(sec, prev !== "false");
            sec.removeAttribute("data-pre-filter-expanded");
          });
          wasFiltering = false;
        }

        syncCategoriesBtn();
      });
    }
  };

  const specCache = new Map();

  const loadAndRenderSpec = async (mountEl, specType, specUrl) => {
    mountEl.innerHTML = `<div class="doc-api-spec-loading">Loading ${esc(
      specType.toUpperCase()
    )} specification...</div>`;
    try {
      let parsed = specCache.get(specUrl);
      if (!parsed) {
        const res = await fetch(specUrl, { cache: "no-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        parsed = parseYAML(text);
        specCache.set(specUrl, parsed);
      }
      if (specType === "asyncapi") {
        renderAsyncAPI(mountEl, parsed, specUrl);
      } else {
        renderOpenAPI(mountEl, parsed, specUrl);
      }
    } catch (err) {
      mountEl.innerHTML = `<div class="doc-api-spec-error">Failed to load specification from <code>${esc(
        specUrl
      )}</code>: ${esc(err.message)}</div>`;
    }
  };

  const initViewers = () => {
    document
      .querySelectorAll("[data-api-standalone-page]")
      .forEach((pageEl) => {
        if (pageEl.getAttribute("data-loaded") === "1") return;
        pageEl.setAttribute("data-loaded", "1");
        document.body.classList.add("is-api-spec-fullpage");
        const specType =
          pageEl.getAttribute("data-api-spec-type") || "openapi";
        const specUrl = pageEl.getAttribute("data-spec-url");
        const mountEl = pageEl.querySelector("[data-api-spec-mount]");
        if (mountEl && specUrl) {
          loadAndRenderSpec(mountEl, specType, specUrl);
        }
      });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initViewers);
  } else {
    initViewers();
  }
})();
