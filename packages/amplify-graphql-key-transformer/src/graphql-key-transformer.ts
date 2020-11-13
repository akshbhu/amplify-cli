import { TransformerModelEnhancerBase } from '@aws-amplify/graphql-transformer-core';
import {
  AppSyncDataSourceType,
  DataSourceInstance,
  MutationFieldType,
  QueryFieldType,
  SubscriptionFieldType,
  TranformerTransformSchemaStepContextProvider,
  TransformerContextProvider,
  TransformerModelEnhancementProvider,
  TransformerPrepareStepContextProvider,
  TransformerValidationStepContextProvider,
  TransformerResolverProvider,
} from '@aws-amplify/graphql-transformer-interfaces';
import { DirectiveNode, ObjectTypeDefinitionNode, InputValueDefinitionNode } from 'graphql';
import { DirectiveWrapper } from '@aws-amplify/graphql-model-transformer';

export type Nullable<T> = T | null;
export type OptionalAndNullable<T> = Partial<Nullable<T>>;

export type KeyDirectiveConfiguration = {
  name?: OptionalAndNullable<string>;
  fields: string[];
  queryField: OptionalAndNullable<string>;
};

export const directiveDefinition = /* GraphQl */ `
directive @key(
    name: String,
    fields: [String!]!,
    queryField: String
)on OBJECT
`;

export class KeyTransformer extends TransformerModelEnhancerBase implements TransformerModelEnhancementProvider {
  [x: string]: any;
  private typesWithKeyDirective: Set<string> = new Set();
  /**
   * A Map to hold the directive configuration
   */
  private keyDirectiveConfig: Map<string, KeyDirectiveConfiguration> = new Map();
  private resolverMap: Record<string, TransformerResolverProvider> = {};
  constructor() {
    super('amplify-key-transformer', directiveDefinition);
  }

  object = (definition: ObjectTypeDefinitionNode, directive: DirectiveNode): void => {
    const typeName = definition.name.value;
    const directiveWrapped: DirectiveWrapper = new DirectiveWrapper(directive);
    const options = directiveWrapped.getArguments({
      name: '',
      fields: [],
      queryField: '',
    });
    this.keyDirectiveConfig.set(typeName, options);
    this.typesWithKeyDirective.add(typeName);
  };
  /**
   * 1. There may only be 1 @key without a name (specifying the primary key)
   * 2. There may only be 1 @key with a given name.
   * 3. @key must only reference existing scalar fields that map to DynamoDB S, N, or B.
   * 4. A primary key must not include a 'queryField'.
   * 5. If there is no primary sort key, make sure there are no more LSIs.
   * @param ctx Transfomer Context provider for the validation step
   */
  validate = (ctx: TransformerValidationStepContextProvider) => {
    for (const keyTypeName of this.typesWithKeyDirective) {
      const typeName = ctx.output.getObject(keyTypeName);
      const definition = ctx.inputDocument.definitions;
    }
  };

  prepare = (context: TransformerPrepareStepContextProvider) => {
    for (const keyTypeName of this.typesWithKeyDirective) {
      const type = context.output.getObject(keyTypeName);
      context.providerRegistry.addDataSourceEnhancer(type!, this);
    }
  };

  transformSchema = (ctx: TranformerTransformSchemaStepContextProvider): void => {};

  generateResolvers = (context: TransformerContextProvider): void => {};

  generateGetResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    return this.resolverMap['test'];
  };

  generateListResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    return this.resolverMap['test'];
  };

  generateUpdateResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    return this.resolverMap['test'];
  };

  generateDeleteResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    return this.resolverMap['test'];
  };

  generateOnCreateResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    return this.resolverMap['test'];
  };

  generateOnUpdateResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    return this.resolverMap['test'];
  };

  generateOnDeleteResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    return this.resolverMap['test'];
  };

  generateSyncResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    return this.resolverMap['test'];
  };

  getQueryFieldNames = (
    ctx: TranformerTransformSchemaStepContextProvider,
    type: ObjectTypeDefinitionNode,
  ): Set<{ fieldName: string; typeName: string; type: QueryFieldType }> => {
    return new Set();
  };

  getMutationFieldNames = (
    ctx: TranformerTransformSchemaStepContextProvider,
    type: ObjectTypeDefinitionNode,
  ): Set<{ fieldName: string; typeName: string; type: MutationFieldType }> => {
    return new Set();
  };

  getSubscriptionFieldNames = (
    ctx: TranformerTransformSchemaStepContextProvider,
    type: ObjectTypeDefinitionNode,
  ): Set<{
    fieldName: string;
    typeName: string;
    type: SubscriptionFieldType;
  }> => {
    return new Set();
  };

  generateCreateResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    return this.resolverMap['test'];
  };

  getInputs = (
    ctx: TranformerTransformSchemaStepContextProvider,
    type: ObjectTypeDefinitionNode,
    operation: {
      fieldName: string;
      typeName: string;
      type: QueryFieldType | MutationFieldType | SubscriptionFieldType;
    },
  ): InputValueDefinitionNode[] => {
    return [];
  };

  getOutputType = (
    ctx: TranformerTransformSchemaStepContextProvider,
    type: ObjectTypeDefinitionNode,
    operation: {
      fieldName: string;
      typeName: string;
      type: QueryFieldType | MutationFieldType | SubscriptionFieldType;
    },
  ): ObjectTypeDefinitionNode => {
    return <ObjectTypeDefinitionNode>type;
  };

  getDataSourceResource = (ctx: TransformerContextProvider, type: ObjectTypeDefinitionNode): DataSourceInstance => {
    // Todo: add sanity check to ensure the type has an table
    return this.ddbTableMap[type.name.value];
  };

  getDataSourceType = (): AppSyncDataSourceType => {
    return AppSyncDataSourceType.AMAZON_DYNAMODB;
  };
}
