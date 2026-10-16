/* DSH compatibility bundle: DSH-BROWSER-USE-CLIENT-1 */
window.__ModuleLoader__.load({
	id: "dsh-browser-use",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		"use strict";
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __export = (target, all) => {
		  for (var name in all)
		    __defProp(target, name, { get: all[name], enumerable: true });
		};
		var __copyProps = (to, from, except, desc) => {
		  if (from && typeof from === "object" || typeof from === "function") {
		    for (let key of __getOwnPropNames(from))
		      if (!__hasOwnProp.call(to, key) && key !== except)
		        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
		  }
		  return to;
		};
		var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

		// src/client/index.tsx
		var index_exports = {};
		__export(index_exports, {
		  apply: () => apply,
		  inject: () => inject
		});
		module.exports = __toCommonJS(index_exports);

		// src/client/ids.ts
		var PANEL_ID = "dsh-browser-use";
		var INJECT = [];
		var DIAGNOSTIC_PREFIX = "[dsh-browser-use]";

		// src/client/index.tsx
		var inject = INJECT;
		function apply(ctx) {
		  if (typeof ctx !== "object" || ctx === null) {
		    console.warn(`${DIAGNOSTIC_PREFIX} \u5BA2\u6237\u7AEF apply \u62FF\u5230\u7684 ctx \u4E0D\u53EF\u7528\uFF0C\u8DF3\u8FC7\u3002`);
		    return;
		  }
		  console.warn(
		    `${DIAGNOSTIC_PREFIX} ${PANEL_ID} \u5BA2\u6237\u7AEF\u5DF2\u52A0\u8F7D\uFF08\u65E0\u754C\u9762\uFF1A\u6D4F\u89C8\u5668\u662F\u672C\u673A\u5F39\u51FA\u7684\u771F\u5B9E\u7A97\u53E3\uFF0C\u76F4\u63A5\u770B\u5B83/\u64CD\u4F5C\u5B83\uFF1B\u6A21\u578B\u89C6\u89C9\u9760 browser_take_screenshot\uFF09\u3002`
		  );
		}
		return module.exports;
	}
});
