var mods = {}

async function isMod(dir) {
    try {
        await dir.getFileHandle("lovely.toml")
        return true
    } catch {
        try {
            await dir.getDirectoryHandle("lovely")
            return true
        } catch {
            return false
        }
    }
}

async function directoryToObject(dir, isRoot=false, showCompatibleWarning=true) {
    if (isRoot) {
        try {
            await dir.getFileHandle("webcompatible")
        } catch (err) {
            if (showCompatibleWarning) {
                alert("Mod " + dir.name + " may not be web compatible.")
            }
        }
    }
    const object = {}
    for await (const [path, obj] of dir.entries()) {
        if (obj.kind == "directory") {
            object[path] = await directoryToObject(obj)
        } else {
            object[path] = await obj.getFile()
        }
    }
    return object
}

async function pickDirectoryFallback() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.onchange = () => resolve(input.files);
        input.click();
    });
}

function fileListToObject(files, rootName) {
    const root = {};
    for (const file of files) {
        const parts = file.webkitRelativePath.split('/').slice(1);
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
            node[parts[i]] ??= {};
            node = node[parts[i]];
        }
        node[parts[parts.length - 1]] = file;
    }
    return root;
}

async function addModDir() {
    $("makeName").placeholder = "Modded";

    if (window.showDirectoryPicker) {
        const dir_picker = await showDirectoryPicker({ mode: "read", startIn: "downloads" });
        if (await isMod(dir_picker)) {
            mods[dir_picker.name] = await directoryToObject(dir_picker, true)
        } else {
            for await (const [path, obj] of dir_picker.entries()) {
                if (obj.kind == "directory") {
                    mods[obj.name] = await directoryToObject(obj, true)
                }
            }
        }
    } else {
        const files = await pickDirectoryFallback();
        if (!files.length) return;
        const dirName = files[0].webkitRelativePath.split('/')[0];
        const tree = fileListToObject(files, dirName);

        const isSingleMod = 'lovely.toml' in tree || 'lovely' in tree;
        if (isSingleMod) {
            if (!('webcompatible' in tree)) alert("Mod " + dirName + " may not be web compatible.");
            mods[dirName] = tree;
        } else {
            for (const [name, subtree] of Object.entries(tree)) {
                if (typeof subtree === 'object' && !(subtree instanceof File)) {
                    if (!('webcompatible' in subtree)) alert("Mod " + name + " may not be web compatible.");
                    mods[name] = subtree;
                }
            }
        }
    }

    renderModsList()
}

function clearMods() {
    mods = {}
    renderModsList()
}

function renderModsList() {
    const list = $("mod-list");
    list.innerHTML = "";
    for (const mod_name of Object.keys(mods)) {
        const mod_item = document.createElement("label");
        mod_item.innerText = mod_name;
        if (mods["Dump from Lovely"] && mod_name != "Dump from Lovely") {
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = false;
            checkbox.onchange = function() {
                if (checkbox.checked) {
                    mods[mod_name]["dont_patch.txt"] = new File(["true"], "dont_patch.txt", { type: "text/plain" })
                }
            }
            mod_item.prepend(checkbox);
        }
        list.appendChild(mod_item);
        list.appendChild(document.createElement("br"));
    }
}

async function useLovelyDump() {
    if (window.showDirectoryPicker) {
        const dir_picker = await showDirectoryPicker({ mode: "read", startIn: "downloads" });
        mods["Dump from Lovely"] = await directoryToObject(dir_picker, true, false)
    } else {
        const files = await pickDirectoryFallback();
        if (!files.length) return;
        const dirName = files[0].webkitRelativePath.split('/')[0];
        mods["Dump from Lovely"] = fileListToObject(files, dirName);
    }
    alert("Click the checkboxes next to the mods that were in provided dump.")
    renderModsList()
}
