/* Zotero 9.0.x integration. Uses the native magic-wand lookup unchanged. */
var DOIListOrder = null;

async function startup({ id, rootURI }) {
  await Zotero.initializationPromise;
  const scope = { URL };
  Services.scriptloader.loadSubScript(rootURI + "order-book.js", scope);
  DOIListOrder = new DOIListOrderPlugin(id, scope.DOIOrderBook);
  await DOIListOrder.start();
}

function onMainWindowLoad({ window }) { DOIListOrder?.attach(window); }
function onMainWindowUnload({ window }) { DOIListOrder?.detach(window); }
async function shutdown() {
  await DOIListOrder?.stop();
  DOIListOrder = null;
}
function install() {}
function uninstall() {}

class DOIListOrderPlugin {
  constructor(id, engine) {
    this.id = id;
    this.engine = engine;
    this.pref = "extensions.zotero.doiListOrder.state.v1";
    // Refuse to overwrite unreadable saved order data.
    this.book = new engine.Book(Zotero.Prefs.get(this.pref, true) || "");
    this.windows = new Map();
    this.viewContext = null;
    this.active = false;
  }

  async start() {
    this.active = true;
    this.columnKey = await Zotero.ItemTreeManager.registerColumn({
      dataKey: "doiInputOrder", label: "参考文献序号", pluginID: this.id,
      defaultIn: ["default"], width: "110", flex: 0,
      zoteroPersist: ["width", "hidden", "sortDirection"],
      dataProvider: item => {
        const view = this.viewContext;
        const scope = this.scopeFor(view?.collectionTreeRow);
        const rank = scope ? this.book.rank(scope, item) : 0;
        return rank ? String(rank).padStart(8, "0") : "";
      },
      renderCell: (_index, data, column, _primary, doc) => {
        const span = doc.createElement("span");
        span.className = `cell ${column.className || ""}`;
        span.textContent = data ? String(Number(data)) : "";
        return span;
      }
    });
    if (!this.columnKey) throw new Error("Cannot register DOI input-order column");
    for (const win of Zotero.getMainWindows()) await this.attach(win);
  }

  scopeFor(row) {
    if (row?.isCollection?.() && row.ref?.key) return `C:${row.ref.libraryID}:${row.ref.key}`;
    if (row?.isLibrary?.() && row.ref?.libraryID) return `L:${row.ref.libraryID}`;
    return "";
  }

  save() { Zotero.Prefs.set(this.pref, this.book.serialize(), true); }
  log(error) { Zotero.logError(error); }
  alert(win, message) { Zotero.alert(win, "DOI 清单顺序", message); }

  withView(view, callback) {
    const previous = this.viewContext;
    this.viewContext = view;
    try { return callback(); } finally { this.viewContext = previous; }
  }

  patch(record, object, name, makeWrapper) {
    const original = object[name];
    if (typeof original !== "function") throw new Error(`Zotero 9 interface unavailable: ${name}`);
    const wrapped = makeWrapper(original);
    object[name] = wrapped;
    record.restores.push(() => {
      // A later plugin may have wrapped this function. Leave that chain intact;
      // our inactive wrappers then pass straight through to their original.
      if (object[name] === wrapped) object[name] = original;
    });
  }

  async attach(win) {
    if (!this.active || this.windows.has(win) || win.closed) return;
    const record = { restores: [], nodes: [], view: null, timer: null };
    this.windows.set(win, record);
    const plugin = this;
    try {
      this.patch(record, win.Zotero_Lookup, "addItemsFromIdentifier", original => async function (...args) {
        if (!plugin.active || args[1]) return original.apply(this, args);
        const view = win.ZoteroPane?.itemsView;
        const targetRow = view?.collectionTreeRow;
        const target = plugin.scopeFor(targetRow);
        const identifiers = Zotero.Utilities.extractIdentifiers(args[0]?.value || "");
        const plan = plugin.engine.parseList(args[0]?.value || "", text => Zotero.Utilities.extractIdentifiers(text));
        if (!target || !plan.length || identifiers.some(identifier => !identifier.DOI)) {
          return original.apply(this, args);
        }
        let input;
        try {
          const fullList = plan.some(reference => !reference.doi || reference.number !== null);
          input = plugin.book.remember(target, plan, fullList);
          plugin.save();
        } catch (error) {
          plugin.log(error);
          plugin.alert(win, "无法保存清单顺序，本次仍使用 Zotero 原有导入功能。请检查插件错误记录。");
          return original.apply(this, args);
        }
        // Call the native lookup exactly once, with its original arguments and
        // this binding. It remains responsible for translations and attachments.
        const items = identifiers.length ? await original.apply(this, args) : [];
        if (!plugin.active) return items;
        try {
          const allItems = [...await targetRow.getItems()];
          for (const item of Array.isArray(items) ? items : []) {
            if (!allItems.some(existing => existing.key === item.key)) allItems.push(item);
          }
          // The native wand handles DOIs. Explicit non-DOI article URLs in the
          // same complete list are saved by Zotero's own webpage translator.
          const extra = await plugin.importMissing(input.filter(reference => !reference.doi && reference.url), allItems, targetRow, args[2]);
          if (Array.isArray(items)) items.push(...extra);
          plugin.book.bind(target, allItems);
          plugin.save();
          await plugin.applySort(win, target);
          const missing = plugin.book.missing(target, input, allItems);
          if (missing.length) {
            plugin.alert(win, plugin.resultMessage(target, input, allItems));
          }
        } catch (error) { plugin.log(error); }
        return items;
      });
      this.addMenu(win, record, "menu_ToolsPopup");
      this.addMenu(win, record, "zotero-collectionmenu");
      // Native itemsView may not exist yet during window startup.
      const hookView = async () => {
        if (!this.active || win.closed) return;
        const view = win.ZoteroPane?.itemsView;
        if (!view || record.view === view) return;
        record.view = view;
        // Zotero 9 sort() and _getRowData() compute cell values synchronously.
        // Scope the official column provider to that exact view (multi-window safe).
        for (const name of ["sort", "_getRowData"]) {
          this.patch(record, view, name, original => function (...args) {
            if (!plugin.active) return original.apply(this, args);
            return plugin.withView(this, () => original.apply(this, args));
          });
        }
        this.patch(record, view, "changeCollectionTreeRow", original => async function (...args) {
          const result = await original.apply(this, args);
          if (plugin.active) await plugin.applySort(win);
          return result;
        });
        this.installManualDrag(record, win, view);
        await this.applySort(win);
      };
      await hookView();
      record.timer = win.setInterval(() => hookView().catch(error => this.log(error)), 1000);
    } catch (error) {
      this.log(error);
      this.detach(win);
      this.alert(win, "当前窗口接口与插件不兼容，已停止接管此窗口。Zotero 原有导入功能保持可用。");
    }
  }

  async applySort(win, expectedScope = null) {
    const view = win.ZoteroPane?.itemsView;
    const scope = this.scopeFor(view?.collectionTreeRow);
    const record = this.book.record(scope);
    if (!this.active || !scope || (expectedScope && expectedScope !== scope) || !record?.enabled) return;
    await view.waitForLoad();
    if (this.scopeFor(view.collectionTreeRow) !== scope) return;
    const columns = view._getColumns();
    const index = columns.findIndex(column => column.dataKey === this.columnKey);
    if (index < 0) return;
    // Column value cache must be cleared after changing a stored DOI list.
    view._rowCache = {};
    columns[index].hidden = false;
    const prefs = view._getColumnPrefs();
    prefs[this.columnKey] = {
      ...prefs[this.columnKey], hidden: false, ordinal: columns[index].ordinal
    };
    await view._handleColumnSort(index, 1);
  }

  async enableManual(win) {
    const view = win.ZoteroPane?.itemsView;
    const scope = this.scopeFor(view?.collectionTreeRow);
    if (!scope) return this.alert(win, "请先选中普通分类或文库。");
    if (view._searchMode || view.collectionTreeRow.searchText) {
      return this.alert(win, "请先清除搜索和标签筛选，再启用手动排序。");
    }
    await view.waitForLoad();
    if (this.scopeFor(view.collectionTreeRow) !== scope) return;
    const before = this.book.serialize();
    try {
      this.book.beginManual(scope, view.getSortedItems());
      this.save();
    } catch (error) { this.book = new this.engine.Book(before); throw error; }
    await this.applySort(win, scope);
    this.alert(win, "已启用手动拖拽排序。拖动当前列表中的文献到目标行上半部或下半部，插入线表示新位置。支持多选拖动。顺序自动保存在本机。\n\n手动序号为连续位置；原清单编号仍保留，可在插件菜单中恢复。请先清除搜索和标签筛选再拖动。");
  }

  installManualDrag(record, win, view) {
    const plugin = this;
    // Only intercept drags originating in this exact view. Native attachment,
    // cross-window, cross-collection, file and external drops keep their handlers.
    this.patch(record, view, "onDragStart", original => function (event, index) {
      plugin.drag = null;
      const result = original.call(this, event, index);
      const items = this.getSortedItems().filter(item => this.getSelectedItems(true).includes(item.id));
      if (plugin.active && items.length && items.every(item => !item.parentItemID && item.isRegularItem?.())) {
        plugin.drag = { view: this, scope: plugin.scopeFor(this.collectionTreeRow), items };
      }
      return result;
    });
    this.patch(record, view, "onDragOver", original => function (event, row) {
      const plan = plugin.manualDropPlan(this, event, row);
      if (!plan) return original.call(this, event, row);
      event.preventDefault(); event.stopPropagation();
      this.setDropEffect(event, "move");
      const previous = this._dropRow;
      this._dropRow = row;
      Zotero.DragDrop.currentOrientation = plan.after ? 1 : -1;
      if (typeof previous === "number") this.tree.invalidateRow(previous);
      this.tree.invalidateRow(row);
      return false;
    });
    this.patch(record, view, "onDrop", original => async function (event, row) {
      const plan = plugin.manualDropPlan(this, event, row);
      plugin.drag = null;
      if (!plan) return original.call(this, event, row);
      // Native row drop listener is passive; dragover already prevented default.
      event.stopPropagation();
      this._dropRow = null;
      Zotero.DragDrop.currentDragSource = null;
      this.tree.invalidate();
      const before = plugin.book.serialize();
      try {
        if (!plugin.book.moveManual(plan.scope, plan.items.map(item => item.key), plan.target.key, plan.after)) return false;
        plugin.save();
      } catch (error) {
        plugin.book = new plugin.engine.Book(before);
        plugin.log(error); plugin.alert(win, "未能保存手动顺序，已保留原顺序。请重试。");
        return false;
      }
      await plugin.applySort(win, plan.scope);
      if (plugin.scopeFor(this.collectionTreeRow) === plan.scope) await this.selectItems(plan.items.map(item => item.id));
      return false;
    });
    this.patch(record, view, "onDragEnd", original => function (...args) {
      plugin.drag = null;
      return original.apply(this, args);
    });
  }

  manualDropPlan(view, event, row) {
    const scope = this.scopeFor(view.collectionTreeRow);
    const saved = this.book.record(scope);
    const drag = this.drag;
    if (!this.active || !saved?.enabled || !saved.manualDrag || drag?.view !== view || drag.scope !== scope
      || view._searchMode || view.collectionTreeRow.searchText || row < 0
      || view.getSortField() !== this.columnKey || view.getSortDirection() !== 1
      || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return null;
    if (Zotero.DragDrop.currentDragSource !== view.collectionTreeRow) return null;
    const data = event.dataTransfer?.getData("zotero/item");
    if (!data || data.split(',').map(Number).join(',') !== drag.items.map(item => item.id).join(',')) return null;
    const target = view.getRow(row)?.ref;
    if (!target?.isRegularItem?.() || target.parentItemID) return null;
    const rect = event.currentTarget?.getBoundingClientRect?.();
    if (!rect || !rect.height || !Number.isFinite(event.clientY)) return null;
    return { scope, items: drag.items, target, after: event.clientY >= rect.top + rect.height / 2 };
  }

  addMenu(win, record, parentID) {
    const doc = win.document;
    const parent = doc.getElementById(parentID);
    if (!parent) return;
    const menu = doc.createXULElement("menu");
    menu.id = `doi-list-order-${parentID}`;
    menu.setAttribute("label", "DOI 清单顺序");
    const popup = doc.createXULElement("menupopup");
    menu.append(popup);
    const action = (label, callback) => {
      const item = doc.createXULElement("menuitem");
      item.setAttribute("label", label);
      item.addEventListener("command", () => callback().catch(error => {
        this.log(error); this.alert(win, "操作未完成，请稍后重试。原文献内容未修改。");
      }));
      popup.append(item);
    };
    action("启用手动拖拽排序…", () => this.enableManual(win));
    action("暂停手动拖拽（保留当前顺序）", async () => {
      const entry = this.book.record(this.scopeFor(win.ZoteroPane?.itemsView?.collectionTreeRow));
      if (entry?.manualKeys) { entry.manualDrag = false; this.save(); }
    });
    action("恢复原清单顺序（退出手动排序）", async () => {
      const scope = this.scopeFor(win.ZoteroPane?.itemsView?.collectionTreeRow);
      this.book.restoreList(scope); this.save(); await this.applySort(win, scope);
    });
    action("按已记录的顺序显示", async () => {
      const scope = this.scopeFor(win.ZoteroPane?.itemsView?.collectionTreeRow);
      const entry = this.book.record(scope);
      if (!entry) return this.alert(win, "请先在此分类使用魔杖导入，或复制完整文献清单后恢复顺序。");
      entry.enabled = true; this.save(); await this.applySort(win, scope);
    });
    action("从剪贴板恢复完整清单顺序（不导入）…", () => this.restoreFromClipboard(win));
    action("从剪贴板补齐缺少的文献并排序…", () => this.restoreFromClipboard(win, true));
    action("此分类停止自动按 DOI 顺序显示", async () => {
      const scope = this.scopeFor(win.ZoteroPane?.itemsView?.collectionTreeRow);
      const entry = this.book.record(scope);
      if (entry) { entry.enabled = false; this.save(); }
      // Keep the current view; users can click any native column normally.
    });
    parent.append(menu);
    record.nodes.push(menu);
  }

  resultMessage(scope, input, items) {
    const missing = this.book.missing(scope, input, items);
    const record = this.book.record(scope);
    const missingText = missing.map(reference => {
      const saved = record.entries.find(entry => entry.id === reference.id);
      return `${saved?.number || reference.number || '?'}. ${reference.doi || reference.title || reference.url || reference.citation}`;
    }).join("\n");
    return `已记录 ${input.length} 条参考文献，其中 ${input.length - missing.length} 条在当前分类找到对应条目。`
      + (missing.length ? `\n\n尚未对应 ${missing.length} 条（原编号保留）：\n${missingText}\n\n可以手动保存缺少的论文后，再恢复完整清单顺序。` : "\n全部条目已按原清单编号。");
  }

  async importMissing(references, items, row, toggleProgress = () => {}) {
    const added = [];
    const collections = row.isCollection?.() ? [row.ref.id] : false;
    if (!references.length) return added;
    toggleProgress(true);
    try {
      for (const reference of references) {
        if (this.book.candidates(reference, items).length) continue;
        try {
          let result;
          if (reference.doi) {
            const translate = new Zotero.Translate.Search();
            translate.setIdentifier({ DOI: reference.doi });
            translate.setTranslator(await translate.getTranslators());
            result = await translate.translate({ libraryID: row.ref.libraryID, collections, saveAttachments: true });
          } else if (reference.url) {
            // Ambiguous manual entries should be reviewed rather than creating
            // another copy just because their URL fields are empty.
            const title = this.engine.titleKey(reference.title);
            if (title && items.filter(item => item.isRegularItem?.()
              && this.engine.titleKey(item.getField('title')) === title).length > 1) continue;
            const results = await Zotero.HTTP.processDocuments(reference.url, async document => {
              const translate = new Zotero.Translate.Web();
              translate.setDocument(document);
              const translators = await translate.getTranslators();
              if (!translators.length) throw new Error('No article translator for ' + reference.url);
              translate.setTranslator(translators[0]);
              translate.setHandler('select', (_object, choices, callback) => {
                const keys = Object.keys(choices);
                callback(keys.length === 1 ? { [keys[0]]: choices[keys[0]] } : false);
              });
              return translate.translate({ libraryID: row.ref.libraryID, collections, saveAttachments: true });
            });
            result = results.flat();
          }
          for (const item of result || []) {
            if (!items.some(existing => existing.key === item.key)) items.push(item);
            added.push(item);
          }
        } catch (error) { this.log(error); }
      }
    } finally { toggleProgress(false); }
    return added;
  }

  async restoreFromClipboard(win, importMissing = false) {
    const view = win.ZoteroPane?.itemsView;
    const targetRow = view?.collectionTreeRow;
    const scope = this.scopeFor(targetRow);
    if (!scope) return this.alert(win, "请先选中一个普通分类或文库。");
    const text = Zotero.Utilities.Internal.getClipboard("text/plain") || "";
    const plan = this.engine.parseList(text, value => Zotero.Utilities.extractIdentifiers(value));
    if (!plan.length) return this.alert(win, "剪贴板没有识别到文献。请复制完整清单（含 DOI、正式链接及标题），每条一行。");
    const input = this.book.remember(scope, plan, true);
    const items = [...await targetRow.getItems()];
    if (importMissing) await this.importMissing(input, items, targetRow);
    this.book.bind(scope, items);
    this.save();
    await this.applySort(win, scope);
    this.alert(win, this.resultMessage(scope, input, items)
      + (importMissing ? "\n本次只尝试补入未匹配的文献，未重新导入已匹配条目。" : "\n此操作只恢复显示顺序，不会重新导入文献。"));
  }

  detach(win) {
    const record = this.windows.get(win);
    if (!record) return;
    if (record.timer) win.clearInterval(record.timer);
    for (const restore of record.restores.reverse()) restore();
    for (const node of record.nodes) node.remove();
    this.windows.delete(win);
  }

  async stop() {
    this.active = false;
    for (const win of [...this.windows.keys()]) this.detach(win);
    if (this.columnKey) await Zotero.ItemTreeManager.unregisterColumn(this.columnKey);
  }
}
