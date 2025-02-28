const fs = require('fs');
const chalk = require('chalk');
const path = require('path');
const { forOwn } = require('lodash');
const { exists, isFile, isDirectory } = require('../utils/filesystem');
const { runSingleRequest } = require('../runner/run-single-request');
const { bruToEnvJson, getEnvVars } = require('../utils/bru');
const makeJUnitOutput = require('../reporters/junit');
const { rpad } = require('../utils/common');
const { bruToJson, getOptions, collectionBruToJson } = require('../utils/bru');
const { dotenvToJson } = require('@usebruno/lang');

const command = 'run [filename]';
const desc = 'Run a request';

const printRunSummary = (results) => {
  let totalRequests = 0;
  let passedRequests = 0;
  let failedRequests = 0;
  let totalAssertions = 0;
  let passedAssertions = 0;
  let failedAssertions = 0;
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;

  for (const result of results) {
    totalRequests += 1;
    totalTests += result.testResults.length;
    totalAssertions += result.assertionResults.length;
    let anyFailed = false;
    let hasAnyTestsOrAssertions = false;
    for (const testResult of result.testResults) {
      hasAnyTestsOrAssertions = true;
      if (testResult.status === 'pass') {
        passedTests += 1;
      } else {
        anyFailed = true;
        failedTests += 1;
      }
    }
    for (const assertionResult of result.assertionResults) {
      hasAnyTestsOrAssertions = true;
      if (assertionResult.status === 'pass') {
        passedAssertions += 1;
      } else {
        anyFailed = true;
        failedAssertions += 1;
      }
    }
    if (!hasAnyTestsOrAssertions && result.error) {
      failedRequests += 1;
    } else {
      passedRequests += 1;
    }
  }

  const maxLength = 12;

  let requestSummary = `${rpad('Requests:', maxLength)} ${chalk.green(`${passedRequests} passed`)}`;
  if (failedRequests > 0) {
    requestSummary += `, ${chalk.red(`${failedRequests} failed`)}`;
  }
  requestSummary += `, ${totalRequests} total`;

  let assertSummary = `${rpad('Tests:', maxLength)} ${chalk.green(`${passedTests} passed`)}`;
  if (failedTests > 0) {
    assertSummary += `, ${chalk.red(`${failedTests} failed`)}`;
  }
  assertSummary += `, ${totalTests} total`;

  let testSummary = `${rpad('Assertions:', maxLength)} ${chalk.green(`${passedAssertions} passed`)}`;
  if (failedAssertions > 0) {
    testSummary += `, ${chalk.red(`${failedAssertions} failed`)}`;
  }
  testSummary += `, ${totalAssertions} total`;

  console.log('\n' + chalk.bold(requestSummary));
  console.log(chalk.bold(assertSummary));
  console.log(chalk.bold(testSummary));

  return {
    totalRequests,
    passedRequests,
    failedRequests,
    totalAssertions,
    passedAssertions,
    failedAssertions,
    totalTests,
    passedTests,
    failedTests
  };
};

const getBruFilesRecursively = (dir) => {
  const environmentsPath = 'environments';

  const getFilesInOrder = (dir) => {
    let bruJsons = [];

    const traverse = (currentPath) => {
      const filesInCurrentDir = fs.readdirSync(currentPath);

      if (currentPath.includes('node_modules')) {
        return;
      }

      for (const file of filesInCurrentDir) {
        const filePath = path.join(currentPath, file);
        const stats = fs.lstatSync(filePath);

        // todo: we might need a ignore config inside bruno.json
        if (
          stats.isDirectory() &&
          filePath !== environmentsPath &&
          !filePath.startsWith('.git') &&
          !filePath.startsWith('node_modules')
        ) {
          traverse(filePath);
        }
      }

      const currentDirBruJsons = [];
      for (const file of filesInCurrentDir) {
        if (['collection.bru', 'folder.bru'].includes(file)) {
          continue;
        }
        const filePath = path.join(currentPath, file);
        const stats = fs.lstatSync(filePath);

        if (!stats.isDirectory() && path.extname(filePath) === '.bru') {
          const bruContent = fs.readFileSync(filePath, 'utf8');
          const bruJson = bruToJson(bruContent);
          currentDirBruJsons.push({
            bruFilepath: filePath,
            bruJson
          });
        }
      }

      // order requests by sequence
      currentDirBruJsons.sort((a, b) => {
        const aSequence = a.bruJson.seq || 0;
        const bSequence = b.bruJson.seq || 0;
        return aSequence - bSequence;
      });

      bruJsons = bruJsons.concat(currentDirBruJsons);
    };

    traverse(dir);
    return bruJsons;
  };

  return getFilesInOrder(dir);
};

const getCollectionRoot = (dir) => {
  const collectionRootPath = path.join(dir, 'collection.bru');
  const exists = fs.existsSync(collectionRootPath);
  if (!exists) {
    return {};
  }

  const content = fs.readFileSync(collectionRootPath, 'utf8');
  return collectionBruToJson(content);
};

const builder = async (yargs) => {
  yargs
    .option('r', {
      describe: 'Indicates a recursive run',
      type: 'boolean',
      default: false
    })
    .option('cacert', {
      type: 'string',
      description: 'CA certificate to verify peer against'
    })
    .option('env', {
      describe: 'Environment variables',
      type: 'string'
    })
    .option('env-var', {
      describe: 'Overwrite a single environment variable, multiple usages possible',
      type: 'string'
    })
    .option('output', {
      alias: 'o',
      describe: 'Path to write file results to',
      type: 'string'
    })
    .option('format', {
      alias: 'f',
      describe: 'Format of the file results; available formats are "json" (default) or "junit"',
      default: 'json',
      type: 'string'
    })
    .option('insecure', {
      type: 'boolean',
      description: 'Allow insecure server connections'
    })
    .option('bail', {
      type: 'boolean',
      description: 'Stop execution after a failure of a request, test, or assertion'
    })
    .example('$0 run request.bru', 'Run a request')
    .example('$0 run request.bru --env local', 'Run a request with the environment set to local')
    .example('$0 run folder', 'Run all requests in a folder')
    .example('$0 run folder -r', 'Run all requests in a folder recursively')
    .example(
      '$0 run request.bru --env local --env-var secret=xxx',
      'Run a request with the environment set to local and overwrite the variable secret with value xxx'
    )
    .example(
      '$0 run request.bru --output results.json',
      'Run a request and write the results to results.json in the current directory'
    )
    .example(
      '$0 run request.bru --output results.xml --format junit',
      'Run a request and write the results to results.xml in junit format in the current directory'
    );
};

const handler = async function (argv) {
  try {
    let { filename, cacert, env, envVar, insecure, r: recursive, output: outputPath, format, bail } = argv;
    const collectionPath = process.cwd();

    // todo
    // right now, bru must be run from the root of the collection
    // will add support in the future to run it from anywhere inside the collection
    const brunoJsonPath = path.join(collectionPath, 'bruno.json');
    const brunoJsonExists = await exists(brunoJsonPath);
    if (!brunoJsonExists) {
      console.error(chalk.red(`You can run only at the root of a collection`));
      return;
    }

    const brunoConfigFile = fs.readFileSync(brunoJsonPath, 'utf8');
    const brunoConfig = JSON.parse(brunoConfigFile);
    const collectionRoot = getCollectionRoot(collectionPath);

    if (filename && filename.length) {
      const pathExists = await exists(filename);
      if (!pathExists) {
        console.error(chalk.red(`File or directory ${filename} does not exist`));
        return;
      }
    } else {
      filename = './';
      recursive = true;
    }

    const collectionVariables = {};
    let envVars = {};

    if (env) {
      const envFile = path.join(collectionPath, 'environments', `${env}.bru`);
      const envPathExists = await exists(envFile);

      if (!envPathExists) {
        console.error(chalk.red(`Environment file not found: `) + chalk.dim(`environments/${env}.bru`));
        return;
      }

      const envBruContent = fs.readFileSync(envFile, 'utf8');
      const envJson = bruToEnvJson(envBruContent);
      envVars = getEnvVars(envJson);
    }

    if (envVar) {
      let processVars;
      if (typeof envVar === 'string') {
        processVars = [envVar];
      } else if (typeof envVar === 'object' && Array.isArray(envVar)) {
        processVars = envVar;
      } else {
        console.error(chalk.red(`overridable environment variables not parsable: use name=value`));
        return;
      }
      if (processVars && Array.isArray(processVars)) {
        for (const value of processVars.values()) {
          // split the string at the first equals sign
          const match = value.match(/^([^=]+)=(.*)$/);
          if (!match) {
            console.error(
              chalk.red(`Overridable environment variable not correct: use name=value - presented: `) +
                chalk.dim(`${value}`)
            );
            return;
          }
          envVars[match[1]] = match[2];
        }
      }
    }

    const options = getOptions();
    if (bail) {
      options['bail'] = true;
    }
    if (insecure) {
      options['insecure'] = true;
    }
    if (cacert && cacert.length) {
      if (insecure) {
        console.error(chalk.red(`Ignoring the cacert option since insecure connections are enabled`));
      } else {
        const pathExists = await exists(cacert);
        if (pathExists) {
          options['cacert'] = cacert;
        } else {
          console.error(chalk.red(`Cacert File ${cacert} does not exist`));
        }
      }
    }

    if (['json', 'junit'].indexOf(format) === -1) {
      console.error(chalk.red(`Format must be one of "json" or "junit"`));
      return;
    }

    // load .env file at root of collection if it exists
    const dotEnvPath = path.join(collectionPath, '.env');
    const dotEnvExists = await exists(dotEnvPath);
    const processEnvVars = {
      ...process.env
    };
    if (dotEnvExists) {
      const content = fs.readFileSync(dotEnvPath, 'utf8');
      const jsonData = dotenvToJson(content);

      forOwn(jsonData, (value, key) => {
        processEnvVars[key] = value;
      });
    }

    const _isFile = await isFile(filename);
    let results = [];

    let bruJsons = [];

    if (_isFile) {
      console.log(chalk.yellow('Running Request \n'));
      const bruContent = fs.readFileSync(filename, 'utf8');
      const bruJson = bruToJson(bruContent);
      bruJsons.push({
        bruFilepath: filename,
        bruJson
      });
    }

    const _isDirectory = await isDirectory(filename);
    if (_isDirectory) {
      if (!recursive) {
        console.log(chalk.yellow('Running Folder \n'));
        const files = fs.readdirSync(filename);
        const bruFiles = files.filter((file) => file.endsWith('.bru'));

        for (const bruFile of bruFiles) {
          const bruFilepath = path.join(filename, bruFile);
          const bruContent = fs.readFileSync(bruFilepath, 'utf8');
          const bruJson = bruToJson(bruContent);
          bruJsons.push({
            bruFilepath,
            bruJson
          });
        }
        bruJsons.sort((a, b) => {
          const aSequence = a.bruJson.seq || 0;
          const bSequence = b.bruJson.seq || 0;
          return aSequence - bSequence;
        });
      } else {
        console.log(chalk.yellow('Running Folder Recursively \n'));

        bruJsons = getBruFilesRecursively(filename);
      }
    }

    let currentRequestIndex = 0;
    let nJumps = 0; // count the number of jumps to avoid infinite loops
    while (currentRequestIndex < bruJsons.length) {
      const iter = bruJsons[currentRequestIndex];
      const { bruFilepath, bruJson } = iter;

      const start = process.hrtime();
      const result = await runSingleRequest(
        bruFilepath,
        bruJson,
        collectionPath,
        collectionVariables,
        envVars,
        processEnvVars,
        brunoConfig,
        collectionRoot
      );

      results.push({
        ...result,
        runtime: process.hrtime(start)[0] + process.hrtime(start)[1] / 1e9,
        suitename: bruFilepath.replace('.bru', '')
      });

      // bail if option is set and there is a failure
      if (bail) {
        const requestFailure = result?.error;
        const testFailure = result?.testResults?.find((iter) => iter.status === 'fail');
        const assertionFailure = result?.assertionResults?.find((iter) => iter.status === 'fail');
        if (requestFailure || testFailure || assertionFailure) {
          break;
        }
      }

      // determine next request
      const nextRequestName = result?.nextRequestName;
      if (nextRequestName !== undefined) {
        nJumps++;
        if (nJumps > 10000) {
          console.error(chalk.red(`Too many jumps, possible infinite loop`));
          process.exit(1);
        }
        if (nextRequestName === null) {
          break;
        }
        const nextRequestIdx = bruJsons.findIndex((iter) => iter.bruJson.name === nextRequestName);
        if (nextRequestIdx >= 0) {
          currentRequestIndex = nextRequestIdx;
        } else {
          console.error("Could not find request with name '" + nextRequestName + "'");
          currentRequestIndex++;
        }
      } else {
        currentRequestIndex++;
      }
    }

    const summary = printRunSummary(results);
    const totalTime = results.reduce((acc, res) => acc + res.response.responseTime, 0);
    console.log(chalk.dim(chalk.grey(`Ran all requests - ${totalTime} ms`)));

    if (outputPath && outputPath.length) {
      const outputDir = path.dirname(outputPath);
      const outputDirExists = await exists(outputDir);
      if (!outputDirExists) {
        console.error(chalk.red(`Output directory ${outputDir} does not exist`));
        process.exit(1);
      }

      const outputJson = {
        summary,
        results
      };

      if (format === 'json') {
        fs.writeFileSync(outputPath, JSON.stringify(outputJson, null, 2));
      } else if (format === 'junit') {
        makeJUnitOutput(results, outputPath);
      }

      console.log(chalk.dim(chalk.grey(`Wrote results to ${outputPath}`)));
    }

    if (summary.failedAssertions + summary.failedTests + summary.failedRequests > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.log('Something went wrong');
    console.error(chalk.red(err.message));
    process.exit(1);
  }
};

module.exports = {
  command,
  desc,
  builder,
  handler,
  printRunSummary
};
