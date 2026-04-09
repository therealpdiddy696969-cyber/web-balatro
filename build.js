function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}
function string_searchAll(string, regex) {
    regex = regex.toString().replace(/\/(.*)\/g/, "$1")
    const positions = []
    let nextRegex = regex
    while (true) {
        result = string.search(new RegExp(nextRegex))
        if (result == -1) break
        nextRegex = ".{" + result + ",}?" + regex
        positions.push(result)
    }
    return positions
}
function fixTomlQuotes(text) {
    return text.replace(/'{4,}/g, (match) => {
        return match.slice(0, match.length - 3) + " '''";
    });
}
async function fixGotoInZip(zipfile) {
    for (const path of Object.keys(zipfile.files)) {
        if (!path.endsWith('.lua')) continue
        const file = zipfile.file(path)
        if (!file) continue
        let contents = await file.async('string')
        if (!contents.includes('goto') && !contents.includes('::')) continue
        contents = contents.replace(/\bthen\s+goto\s+\w+\s+end/g, 'then end')
        contents = contents.replace(/\bgoto\s+\w+/g, '-- goto (removed)')
        contents = contents.replace(/::\w+::/g, '')
        zipfile.file(path, contents)
    }
}
async function buildFromSource(blob, mods) {
    const progress_bar = $("progressBar")
    const status_text = $("status")
    progress_bar.value = "0"
    status_text.innerText = "Finding Source"
    const buffer = await blob.arrayBuffer()
    const reader = new BufferReader(buffer)
    while (true) {
        if (reader.string(4) === "PK\x03\x04") break
        reader.step(-3)
    }
    progress_bar.value = "30"
    reader.step(-4)
    const pkfile = reader.bytes(reader.view.byteLength - reader.offset)
    function get_file(path) {
        let current = zipfile
        for (const chunk of path.split("/").slice(0, -1)) current = zipfile.folder(chunk)
        const file = current.file(path.split("/").at(-1))
        if (!file) { console.warn("Patch target not found, skipping: " + path); return Promise.resolve(null) }
        return file.async("string")
    }
    function get_mod_file(mod, path) {
        let current = mods[mod]
        for (const chunk of path.split("/")) current = current[chunk]
        return current.text()
    }
    function set_file(path, data) {
        let current = zipfile
        for (const chunk of path.split("/").slice(0, -1)) current = current.folder(chunk)
        current.file(path.split("/").at(-1), data)
    }
    progress_bar.value = "40"
    status_text.innerText = "Extracting zip"
    const zipfile = await JSZip.loadAsync(new Blob([pkfile]))
    const patch_list = [];
    function parseLovelyDump(obj, path) {
        for (const [name, value] of Object.entries(obj)) {
            if (!(value instanceof File)) { parseLovelyDump(value, path + name + "/"); continue; }
            set_file(path + name, value)
        }
    }
    let smodsPreflight = null
    if (mods["Dump from Lovely"]) {
        const dumpTree = mods["Dump from Lovely"]
        const keys = Object.keys(dumpTree)
        const firstVal = keys.length > 0 ? dumpTree[keys[0]] : null
        const isNested = firstVal && !(firstVal instanceof File) && keys.length === 1
        parseLovelyDump(isNested ? dumpTree[keys[0]] : dumpTree, "")
        const preflightPath = Object.keys(zipfile.files).find(p =>
            p.includes('preflight') && p.endsWith('core.lua') && !p.endsWith('.json')
        )
        if (preflightPath) { smodsPreflight = preflightPath; console.log("Found SMODS preflight at:", preflightPath) }
        for (const path of Object.keys(zipfile.files).filter(p => p.startsWith('SMODS/_/'))) {
            const file = zipfile.file(path)
            if (!file || zipfile.files[path].dir) continue
            zipfile.file(path.replace('SMODS/_/', 'SMODS/'), await file.async('uint8array'))
        }
        for (const path of Object.keys(zipfile.files).filter(p => p.startsWith('lovely/SMODS/'))) {
            const file = zipfile.file(path)
            if (!file || zipfile.files[path].dir) continue
            const relative = path.replace('lovely/SMODS/', '')
            const lastSrcIdx = relative.lastIndexOf('src/')
            const flatPath = lastSrcIdx !== -1 ? relative.slice(lastSrcIdx + 4) : relative
            zipfile.file('SMODS/' + flatPath, await file.async('uint8array'))
        }
    }
    for (const [name, mod] of Object.entries(mods)) {
        if (name == "Dump from Lovely") continue
        const tomls = []
        if (mod["lovely.toml"]) tomls.push({ toml: mod["lovely.toml"], path: "lovely.toml" })
        if (mod["lovely"]) {
            for (const [n, patch] of Object.entries(mod["lovely"])) {
                if (n.endsWith(".toml")) tomls.push({ toml: patch, path: "lovely/" + n })
            }
        }
        for (const file of tomls) {
            try {
                patch_list.push({ src: toml.parse(fixTomlQuotes(await file.toml.text())), name, dont_patch: mod["dont_patch.txt"] ? true : false })
            } catch (err) { console.error("Failure parsing mod " + name, err) }
        }
    }
    patch_list.sort((a, b) => a.src.manifest.priority > b.src.manifest.priority ? -1 : a.src.manifest.priority == b.src.manifest.priority ? 0 : 1)
    let modules_to_load = {}
    for (const patch_data of patch_list) {
        status_text.innerText = "Applying mod " + patch_data.name
        for (const block of patch_data.src.patches) {
            if (block.pattern && !patch_data.dont_patch) {
                const patch = block.pattern; patch.limit = patch.limit || Infinity
                let contents = await get_file(patch.target); if (contents === null) continue
                if (patch.position == "at") contents = contents.replace(patch.pattern, patch.payload)
                else if (patch.position == "before") contents = contents.replace(patch.pattern, patch.payload + " " + patch.pattern)
                else contents = contents.replace(patch.pattern, patch.pattern + " " + patch.payload)
                set_file(patch.target, contents)
            }
            if (block.regex && !patch_data.dont_patch) {
                const patch = block.regex; patch.limit = patch.limit || Infinity
                patch.line_prepend = patch.line_prepend || ""
                patch.payload = patch.line_prepend + patch.payload.replace("\n", "\n" + patch.line_prepend)
                const pattern = new RegExp(patch.pattern, "g")
                let contents = await get_file(patch.target); if (contents === null) continue
                let locs = [], data
                while ((data = pattern.exec(contents)) !== null) locs.push({ index: data.index, index_groups: data.slice(1), groups: data.groups ?? {}, match: data[0] })
                let delta = 0, i = 0
                for (const match of locs) {
                    if (i > patch.limit) break; i++
                    let replacer = patch.payload, original_size = match.match.length
                    for (let j = 0; j < match.index_groups.length; j++) replacer = replacer.replaceAll("$" + (j + 1), match.index_groups[j])
                    for (const [key, value] of Object.entries(match.groups)) replacer = replacer.replaceAll("$" + key, value)
                    if (patch.position == "at") { contents = contents.slice(0, match.index + delta) + replacer + contents.slice(match.index + delta + original_size); delta += replacer.length - original_size }
                    else if (patch.position == "before") { contents = contents.slice(0, match.index + delta) + replacer + contents.slice(match.index + delta); delta += replacer.length }
                    else { contents = contents.slice(0, match.index + delta + original_size) + replacer + contents.slice(match.index + delta + original_size); delta += replacer.length }
                }
                set_file(patch.target, contents)
            }
            if (block.copy && !patch_data.dont_patch) {
                const patch = block.copy
                let contents = await get_file(patch.target); if (contents === null) continue
                if (patch.position == "before") { for (const f of patch.sources) contents = "-- " + patch_data.name + " - " + f + "\n" + await get_mod_file(patch_data.name, f) + "\n" + contents }
                else { for (const f of patch.sources) contents += "\n-- " + patch_data.name + " - " + f + "\n" + await get_mod_file(patch_data.name, f) }
                set_file(patch.target, contents)
            }
            if (block.module) {
                const patch = block.module
                set_file(patch.name.replace(".", "/") + ".lua", await get_mod_file(patch_data.name, patch.source))
                if (!patch_data.dont_patch) { modules_to_load[patch.before] = modules_to_load[patch.before] || []; modules_to_load[patch.before].push(patch.name) }
            }
        }
    }
    for (const [path, module] of Object.entries(modules_to_load)) {
        let contents = await get_file(path); if (contents === null) continue
        for (const to_require of module) contents += `\nrequire '${to_require}'`
        set_file(path, contents)
    }
    function move_dir(dir, path) {
        for (const [name, file] of Object.entries(dir)) {
            if (!(file instanceof File)) { zipfile.folder(path + name); move_dir(file, path + name + "/") }
            else zipfile.file(path + name, file)
        }
    }
    const mods_without_dump = {}
    for (const [mod_name, mod_data] of Object.entries(mods)) {
        if (mod_name != "Dump from Lovely") mods_without_dump[mod_name] = mod_data
    }
    console.log(mods_without_dump)
    move_dir(mods_without_dump, "Mods/")
    // Copy SMODS src files so SMODS.path resolves
    const smodsFolderEntry = Object.keys(zipfile.files).find(p => p.startsWith('Mods/') && p.toLowerCase().includes('smods') && p.split('/').length === 3 && p.endsWith('/'))
    const smodsFolderName = smodsFolderEntry ? smodsFolderEntry.split('/')[1] : null
    if (smodsFolderName) {
        const smodsModSrc = 'Mods/' + smodsFolderName + '/src/'
        for (const path of Object.keys(zipfile.files).filter(p => p.startsWith(smodsModSrc))) {
            const file = zipfile.file(path); if (!file || zipfile.files[path].dir) continue
            const contents = await file.async('uint8array'); const relPath = path.replace(smodsModSrc, '')
            zipfile.file('SMODS/src/' + relPath, contents); zipfile.file('SMODS/' + relPath, contents)
        }
        console.log("Copied SMODS src files from Mods/" + smodsFolderName + "/src/")
    }
    // Fix goto in ALL lua files after everything is in the zip
    await fixGotoInZip(zipfile)

    // Patch loader.lua — nil-safe loadMods call
    for (const lp of ['SMODS/preflight/loader.lua', 'SMODS/src/preflight/loader.lua']) {
        const lf = zipfile.file(lp)
        if (!lf) continue
        let lc = await lf.async('string')
        lc = lc.replace('loadMods(SMODS.MODS_DIR)', 'loadMods(SMODS.MODS_DIR or "Mods")')
        zipfile.file(lp, lc)
        console.log('Patched loadMods in', lp)
    }

    // Patch core.lua — don't overwrite SMODS if already set
    if (smodsPreflight) {
        const coreLuaFile = zipfile.file(smodsPreflight)
        if (coreLuaFile) {
            let coreLua = await coreLuaFile.async('string')
            // Prepend a guard so core.lua doesn't wipe our SMODS stub
            coreLua = 'if not SMODS then SMODS = {} end\n' +
                      'SMODS.MODS_DIR = SMODS.MODS_DIR or "Mods"\n' +
                      'SMODS.id = SMODS.id or "Steamodded"\n' + coreLua
            zipfile.file(smodsPreflight, coreLua)
            console.log('Patched core.lua to preserve SMODS')
        }
    }
    progress_bar.value = "50"
    status_text.innerText = "Applying Patches"
    for (const patch_file of Object.keys(window.patches)) zipfile.file(patch_file, window.patches[patch_file])
    // Override SMODS nativefs last
    if (mods["Dump from Lovely"]) zipfile.file("SMODS/nativefs.lua", window.patches["nativefs.lua"])
    if (!zipfile.file("web_patched") || mods["Dump from Lovely"]) {
        progress_bar.value = "60"
        {
            const main = zipfile.file("main.lua")
            let contents = await main.async("string")
            let preflightBootstrap = ''
            if (smodsPreflight) {
                const requirePath = smodsPreflight.replace(/\.lua$/, '')
                preflightBootstrap = '-- Bootstrap SMODS preflight (web build)\n' +
                    'if not SMODS then SMODS = {} end\n' +
                    'SMODS.MODS_DIR = SMODS.MODS_DIR or "Mods"\n' +
                    'SMODS.id = SMODS.id or "Steamodded"\n' +
                    'require "' + requirePath + '"\n'
            }
            contents = preflightBootstrap + 'require "web_patches"\n' + contents
            contents = contents.replace('assert(SMODS.path,',
                () => 'NFS.workingDirectory = ""\n' +
                    'if SMODS and SMODS.path then\n' +
                    '    SMODS.path = SMODS.path:match("(Mods/[^/]+/)") or SMODS.path\n' +
                    'end\n' +
                    'if SMODS then\n' +
                    '    SMODS.MODS_DIR = SMODS.MODS_DIR or "Mods"\n' +
                    '    SMODS.id = SMODS.id or "Steamodded"\n' +
                    'end\n' +
                    'assert(SMODS.path,')
            contents = contents.replace(/if os == 'OS X' or os == 'Windows' then\s/, () => "if false then ")
            contents = contents.replace("G:start_up()", () => "G.SOUND_MANAGER = { channel = { push = function() end } }\n    G:start_up()")
            zipfile.file("main.lua", contents)
        }
        progress_bar.value = "70"
        { const c = await zipfile.file("globals.lua").async("string"); zipfile.file("globals.lua", c.replace("F_SOUND_THREAD = true", "F_SOUND_THREAD = false")) }
        progress_bar.value = "80"
        { const c = await zipfile.folder("resources").folder("shaders").file("hologram.fs").async("string"); zipfile.folder("resources").folder("shaders").file("hologram.fs", c.replace(/glow_samples;/g, "4;")) }
        {
            const gameFile = zipfile.file('game.lua')
            if (gameFile) {
                let gc = await gameFile.async('string')
                gc = gc.replace('self.SHADERS[shader_name] = love.graphics.newShader(shader)',
                    'print("Compiling shader: " .. tostring(shader_name))\n' +
                    'local _ok, _s = pcall(love.graphics.newShader, shader)\n' +
                    'if _ok then self.SHADERS[shader_name] = _s print("Done: " .. tostring(shader_name))\n' +
                    'else print("SHADER FAILED: " .. tostring(shader_name)) end')
                zipfile.file('game.lua', gc)
            }
        }
        {
            const confFile = zipfile.file("conf.lua")
            if (confFile) {
                let c = await confFile.async("string")
                c = c.replace("t.window.fullscreen = true", "t.window.fullscreen = false")
                c += "\nt.window.fullscreen = false"
                zipfile.file("conf.lua", c)
            }
        }
        zipfile.file("web_patched", "true")
    }
    progress_bar.value = "90"
    status_text.innerText = "Zipping zip"
    const game = await zipfile.generateAsync({ type: "blob" })
    progress_bar.value = "100"
    status_text.innerText = "Done"
    return game
}
