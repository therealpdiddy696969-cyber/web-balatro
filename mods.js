let mods = {} 
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
        // webkitRelativePath = "rootFolder/subdir/file.ext"
        const parts = file.webkitRelativePath.split('/').slice(1); // strip root folder name
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
    
    let modTree, dirName;

    if (window.showDirectoryPicker) {
        const dir_picker = await showDirectoryPicker({ mode: "read", startIn: "downloads" });
        dirName = dir_picker.name;
        if (await isMod(dir_picker)) {
            mods[dirName] = await directoryToObject(dir_picker, true);
        } else {
            for await (const [path, obj] of dir_picker.entries()) {
                if (obj.kind == "directory") {
                    mods[obj.name] = await directoryToObject(obj, true);
                }
            }
        }
    } else {
        // Firefox/Brave fallback
        const files = await pickDirectoryFallback();
        if (!files.length) return;
        dirName = files[0].webkitRelativePath.split('/')[0];
        const tree = fileListToObject(files, dirName);
        
        // Check if it's a single mod or collection
        const isSingleMod = 'lovely.toml' in tree || 'lovely' in tree;
        if (isSingleMod) {
            // webcompatible warning
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

    renderModsList();
}
