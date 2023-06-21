/* globals require, __dirname, Buffer */

const path = require('path');
const fs = require('fs');
const md5 = require('md5');
const hostlistCompiler = require('@adguard/hostlist-compiler');
const mastodonServerlistCompiler = require('adguard-hostlists-builder/mastodon');

const HOSTLISTS_URL = 'https://adguardteam.github.io/HostlistsRegistry/assets';

const CONFIGURATION_FILE = 'configuration.json';
const REVISION_FILE = 'revision.json';
const METADATA_FILE = 'metadata.json';
const SERVICES_FILE = 'services.json';

const FILTERS_METADATA_FILE = 'filters.json';
const FILTERS_METADATA_DEV_FILE = "filters-dev.json";
const FILTERS_I18N_METADATA_FILE = 'filters_i18n.json';

/**
 * Sync reads file content
 *
 * @param path
 * @returns {*}
 */
const readFile = function (path) {
  if (!fs.existsSync(path)) {
    return null;
  }
  return fs.readFileSync(path, { encoding: 'utf-8' });
};

/**
 * Sync writes content to file
 *
 * @param path
 * @param data
 */
const writeFile = function (path, data) {
  fs.writeFileSync(path, data, 'utf8');
};

/**
 * Lists directories in the base directory.
 * @param {String} baseDir - base directory
 * @returns {*}
 */
const listDirs = function (baseDir) {
  return fs.readdirSync(baseDir)
    .filter(file => fs.statSync(path.join(baseDir, file)).isDirectory())
    .map(file => path.join(baseDir, file));
}

/**
 * Lists directories with filters metadata in the base dir
 * @param baseDir Base directory
 * @return {*}
 */
const listFiltersDirs = function (baseDir) {
  const childDirs = listDirs(baseDir);

  let filterDirs = [];
  for (let dir of childDirs) {
    if (fs.existsSync(path.join(dir, 'configuration.json'))) {
      filterDirs.push(dir);
    } else {
      filterDirs = filterDirs.concat(listFiltersDirs(dir));
    }
  }
  return filterDirs;
}

/**
 * Creates revision object,
 * doesn't update timeUpdated if hash is not changed
 *
 * @param currentRevision
 * @param hash
 * @returns {{timeUpdated: number, hash: String}}
 */
const makeRevision = function (currentRevision, hash) {
  const result = {
    timeUpdated: new Date().getTime(),
    hash,
  };

  if (currentRevision && currentRevision.hash === result.hash) {
    result.timeUpdated = currentRevision.timeUpdated;
  }

  return result;
};

/**
 * Calculates revision for compiled rules.
 * NOTE: "! Last modified:" comment is excluded from the calculation because it's updating each time hostlist-compiler invoked
 *
 * @param compiled Array with compiled rules
 * @return {String}
 */
const calculateRevisionHash = function (compiled) {
  const data = compiled.filter(s => !s.startsWith('! Last modified:')).join('\n');
  return Buffer.from(md5(data, { asString: true })).toString('base64').trim();
}

/**
 * Parses "Expires" field and converts it to seconds
 *
 * @param expires
 */
const replaceExpires = function (expires) {
  if (expires) {
    if (expires.indexOf('day') > 0) {
      expires = parseInt(expires, 10) * 24 * 60 * 60;
    } else if (expires.indexOf('hour') > 0) {
      expires = parseInt(expires, 10) * 60 * 60;
    }
    if (Number.isNaN(expires)) {
      // Default
      expires = 86400;
    }
  }
  return expires || 86400;
};

const readHostlistConfiguration = function (filterDir) {
  const configurationFile = path.join(filterDir, CONFIGURATION_FILE);
  return JSON.parse(readFile(configurationFile));
}

/**
 * Parses object info
 * Splits string {mask}{id}.{message} like "filter.1.name" etc.
 *
 * @param string
 * @param mask
 * @returns {{id: *, message: *}}
 */
const parseInfo = (string, mask) => {
  const searchIndex = string.indexOf(mask) + mask.length;
  return {
    id: string.substring(searchIndex, string.indexOf('.', searchIndex)),
    message: string.substring(string.lastIndexOf('.') + 1),
  };
};

/**
 * Loads localizations
 *
 * @param dir
 */
const loadLocales = function (dir) {
  const result = {
    tags: {},
    filters: {},
  };

  const localeDirs = listDirs(dir);
  for (const localeDir of localeDirs) {

    const locale = path.basename(localeDir);

    const items = [{
      file: path.join(localeDir, 'tags.json'),
      prefix: 'hostlisttag.',
      propName: 'tags'
    }, {
      file: path.join(localeDir, 'filters.json'),
      prefix: 'hostlist.',
      propName: 'filters'
    }];

    for (let item of items) {
      const messagesJson = JSON.parse(readFile(item.file));
      if (messagesJson) {
        for (const message of messagesJson) {
          for (const property of Object.keys(message)) {
            const info = parseInfo(property, item.prefix);
            if (!info || !info.id) {
              continue;
            }
            const { id } = info;
            const propName = item.propName;
            result[propName][id] = result[propName][id] || {};
            result[propName][id][locale] = result[propName][id][locale] || {};
            result[propName][id][locale][info.message] = message[property];
          }
        }
      }
    }
  }

  return result;
};

async function build(filtersDir, tagsDir, localesDir, assetsDir) {
  const filtersMetadata = [];
  const filtersMetadataDev = [];

  const filterDirs = listFiltersDirs(filtersDir);
  for (const filterDir of filterDirs) {
    const metadata = JSON.parse(readFile(path.join(filterDir, METADATA_FILE)));

    // Reads the current revision information.
    const revisionFile = path.join(filterDir, REVISION_FILE);
    const currentRevision = JSON.parse(readFile(revisionFile)) || { timeUpdated: new Date().getTime() };
    let timeUpdated = currentRevision.timeUpdated;

    // Compiles the hostlist using provided configuration.
    const hostlistConfiguration = readHostlistConfiguration(filterDir);
    const filterName = `filter_${metadata.id}.txt`;

    // If the hostlist is disabled, do not attempt to download it, just use the
    // existing one.
    if (!metadata.disabled) {
      try {
        const hostlistCompiled = await hostlistCompiler(hostlistConfiguration);
        const hash = calculateRevisionHash(hostlistCompiled);

        // Rewrites the filter if it's actually changed.

        if (currentRevision.hash !== hash) {
          const newRevision = makeRevision(currentRevision, hash);
          const assetsFilterFile = path.join(assetsDir, filterName);
          const filterFile = path.join(filterDir, 'filter.txt');
          let content = hostlistCompiled.join('\n');

          timeUpdated = newRevision.timeUpdated;
          writeFile(revisionFile, JSON.stringify(newRevision, null, '\t'));
          writeFile(assetsFilterFile, content);
          writeFile(filterFile, content);
        }
      } catch (ex) {
        throw new Error(`Failed to compile ${metadata.id}: ${ex}`);
      }
    }

    const downloadUrl = `${HOSTLISTS_URL}/${filterName}`;

    let sourceUrl;
    if (hostlistConfiguration.sources.length === 1) {
      sourceUrl = hostlistConfiguration.sources[0].source;
    } else {
      sourceUrl = metadata.homepage;
    }

    // populates metadata for filter
    const filterMetadata = {
      filterId: metadata.filterId,
      id: metadata.id,
      name: metadata.name,
      description: metadata.description,
      tags: metadata.tags,
      homepage: metadata.homepage,
      expires: replaceExpires(metadata.expires),
      displayNumber: metadata.displayNumber,
      downloadUrl: downloadUrl,
      sourceUrl: sourceUrl,
      timeAdded: metadata.timeAdded,
      timeUpdated: timeUpdated,
    };

    console.log();
    console.log('--- metadata filter id: ', filterMetadata.id);
    console.log();

    if (metadata.environment === "prod") {
      filtersMetadata.push(filterMetadata);
    }
    filtersMetadataDev.push(filterMetadata);
  }

  // Build Mastodon dynamic server list
  let services = JSON.parse(readFile(path.join(assetsDir, SERVICES_FILE)));
  const mastodonServers = await mastodonServerlistCompiler();

  const mastodonIndex = services.blocked_services
    .findIndex((el) => {
      return el.id === 'mastodon';
    });

  if (mastodonIndex == -1) {
    throw Error("Mastodon service not found")
  }

  // Set Mastodon server list to be blocked
  const mastodonService = services.blocked_services[mastodonIndex];
  mastodonService.rules = mastodonServers;
  services.blocked_services[mastodonIndex] = mastodonService;

  // Write Mastodon dynamic server list to service.json
  const servicesFile = path.join(assetsDir, SERVICES_FILE);
  writeFile(servicesFile, JSON.stringify(services, undefined, 2));

  // copy tags as is
  const tagsMetadata = JSON.parse(readFile(path.join(tagsDir, METADATA_FILE)));

  // writes the populated metadata for all filters, tags, etc that are marked as "prod"
  const filtersMetadataFile = path.join(assetsDir, FILTERS_METADATA_FILE);
  writeFile(filtersMetadataFile, JSON.stringify({ filters: filtersMetadata, tags: tagsMetadata }, null, '\t'));

  // writes the metadata for all filters, tags, etc that are marked as "dev"
  const filtersMetadataDevFile = path.join(assetsDir, FILTERS_METADATA_DEV_FILE);
  writeFile(filtersMetadataDevFile, JSON.stringify({ filters: filtersMetadataDev, tags: tagsMetadata }, null, '\t'));

  // writes localizations for all filters, tags, etc
  const localizations = loadLocales(localesDir);
  const filtersI18nFile = path.join(assetsDir, FILTERS_I18N_METADATA_FILE);
  const i18nMetadata = {
    tags: localizations.tags,
    filters: localizations.filters,
  };
  writeFile(filtersI18nFile, JSON.stringify(i18nMetadata, null, '\t'));
}

module.exports = {
  build
};
